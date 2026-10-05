import * as THREE from 'three/webgpu';
import { assets } from '../core/AssetRegistry';
import { renderFlags } from '../core/Renderer';
import { tex } from '../core/Textures';
import type { QualityPreset } from '../core/Settings';
import type { Route } from '../track/Route';
import { PROP_STRIDE, PROP_TYPES, PropType } from './scenery/Placement';
import { propMaterials, propTemplate } from './scenery/Props';
import type { TileRequest } from './terrain.worker';
import { REGIONS } from '../data';

export const TILE = 400;

/**
 * Hide texture repetition on the ground: blend the map at two scales with a
 * soft value-noise mask (classic WebGL path; the WebGPU path keeps the plain map).
 */
function breakUpTiling(m: THREE.MeshStandardMaterial) {
  if (!renderFlags.classic) return;
  m.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
float rbHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float rbNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(rbHash(i), rbHash(i + vec2(1.0, 0.0)), u.x), mix(rbHash(i + vec2(0.0, 1.0)), rbHash(i + vec2(1.0, 1.0)), u.x), u.y);
}`)
      .replace('#include <map_fragment>', `#ifdef USE_MAP
  vec4 tA = texture2D(map, vMapUv);
  vec4 tB = texture2D(map, vMapUv * 0.29 + vec2(0.37, 0.71));
  float nMask = rbNoise(vMapUv * 0.06) * 0.65 + rbNoise(vMapUv * 0.17 + 3.1) * 0.35;
  diffuseColor *= mix(tA, tB, smoothstep(0.36, 0.64, nMask));
#endif`);
  };
  m.customProgramCacheKey = () => 'terrain-antitile';
}

interface Tile {
  key: string; tx: number; tz: number;
  res: number; scenery: TileRequest['scenery'];
  group: THREE.Group | null;
  pendingId: number; // >0 while a rebuild is in flight
  wantRes: number; wantScenery: TileRequest['scenery'];
}

export const waterMaterial = new THREE.MeshStandardMaterial({ color: 0x3b6470, roughness: 0.06, metalness: 0.35, transparent: true, opacity: 0.86 });

/**
 * Streams terrain tiles + scenery around the camera using a pool of workers.
 * Resolution and scenery detail fall off with distance; far tiles are coarse
 * and bare, near tiles get full instanced scenery.
 */
export class ChunkManager {
  readonly root = new THREE.Group();
  private tiles = new Map<string, Tile>();
  private workers: Worker[] = [];
  private ready = 0;
  private nextId = 1;
  private inFlight = new Map<number, Tile>();
  private rr = 0;
  readonly terrainMaterial: THREE.MeshStandardMaterial;
  private queueLimit: number;
  ponds = new Map<string, THREE.Mesh>();

  constructor(route: Route, private preset: () => QualityPreset) {
    this.root.name = 'terrain';
    this.terrainMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.97, metalness: 0 });
    assets.bindTextureSet(this.terrainMaterial, 'terrain/ground', tex.ground, 6); // terrain UVs: 1 unit = 6 m
    breakUpTiling(this.terrainMaterial);
    const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    this.queueLimit = n * 2;
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./terrain.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = e => this.onMessage(e.data);
      w.onerror = e => console.error('terrain worker error', e.message);
      w.postMessage({ type: 'init', route: route.data, regions: REGIONS });
      this.workers.push(w);
    }
  }

  /** live counts for the perf overlay */
  tileCount = 0;
  grassCount = 0;
  propCount = 0;

  get workersReady() { return this.ready === this.workers.length; }

  /** Tiles still missing near the camera (for the loading screen). */
  pendingNear(x: number, z: number, radius: number) {
    let n = 0;
    for (const t of this.tiles.values()) {
      const d = Math.hypot((t.tx + 0.5) * TILE - x, (t.tz + 0.5) * TILE - z);
      if (d < radius && (!t.group || t.res !== t.wantRes)) n++;
    }
    return n;
  }

  private onMessage(m: any) {
    if (m.type === 'ready') { this.ready++; return; }
    if (m.type !== 'tile') return;
    const tile = this.inFlight.get(m.id);
    this.inFlight.delete(m.id);
    if (!tile || tile.pendingId !== m.id) return;
    tile.pendingId = 0;
    if (!this.tiles.has(tile.key)) return; // unloaded meanwhile
    const g = this.buildTileGroup(tile, m);
    if (tile.group) this.disposeGroup(tile.group);
    tile.group = g;
    this.root.add(g);
    this.count(g, 1);
  }

  private buildTileGroup(tile: Tile, m: any) {
    const group = new THREE.Group();
    group.position.set(tile.tx * TILE, 0, tile.tz * TILE);
    const geo = new THREE.BufferGeometry();
    const vc = m.vCount as number;
    geo.setAttribute('position', new THREE.BufferAttribute((m.pos as Float32Array).subarray(0, vc * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute((m.nor as Float32Array).subarray(0, vc * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute((m.col as Float32Array).subarray(0, vc * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute((m.uv as Float32Array).subarray(0, vc * 2), 2));
    geo.setIndex(new THREE.BufferAttribute(m.indices as Uint32Array, 1));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.terrainMaterial);
    mesh.receiveShadow = true;
    mesh.castShadow = tile.res >= 40;
    group.add(mesh);

    // Props: one draw per material. Multi-shape materials use a BatchedMesh (one
    // multi-draw for every hut, house, temple, tree...), single-shape grass and
    // impostors stay InstancedMesh. Instance matrices are tile-local (small numbers).
    const mats = propMaterials();
    const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();
    const up = new THREE.Vector3(0, 1, 0);
    const byMat = new Map<string, { type: PropType; part: ReturnType<typeof propTemplate>[number]; arr: Float32Array }[]>();
    for (const t of PROP_TYPES) {
      const arr = (m.props as Record<string, Float32Array>)[t];
      if (!arr || !arr.length) continue;
      const count = arr.length / PROP_STRIDE;
      if (t === 'grass') group.userData.grass = count; else group.userData.props = (group.userData.props ?? 0) + count;
      for (const part of propTemplate(t)) {
        const list = byMat.get(part.material) ?? [];
        list.push({ type: t, part, arr });
        byMat.set(part.material, list);
      }
    }
    const fill = (set: (i: number, mtx: THREE.Matrix4, col: THREE.Color) => void, arr: Float32Array) => {
      for (let i = 0, n = arr.length / PROP_STRIDE; i < n; i++) {
        const o = i * PROP_STRIDE;
        _p.set(arr[o] - tile.tx * TILE, arr[o + 1], arr[o + 2] - tile.tz * TILE);
        _q.setFromAxisAngle(up, arr[o + 3]);
        _s.set(arr[o + 4], arr[o + 5], arr[o + 6]);
        set(i, _m.compose(_p, _q, _s), _c.setRGB(arr[o + 7], arr[o + 8], arr[o + 9]));
      }
    };
    for (const [key, list] of byMat) {
      const material = mats[key];
      const shadow = list[0].part.shadow;
      let mesh: THREE.Mesh;
      if (list.length === 1) {
        const { part, arr } = list[0];
        const im = new THREE.InstancedMesh(part.geometry, material, arr.length / PROP_STRIDE);
        fill((i, mtx, col) => { im.setMatrixAt(i, mtx); im.setColorAt(i, col); }, arr);
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        im.computeBoundingBox();
        im.computeBoundingSphere();
        mesh = im;
      } else {
        let instances = 0, vertices = 0, indices = 0;
        for (const { part, arr } of list) { instances += arr.length / PROP_STRIDE; vertices += part.geometry.attributes.position.count; indices += part.geometry.index?.count ?? 0; }
        const bm = new THREE.BatchedMesh(instances, vertices, indices, material);
        bm.sortObjects = false;            // opaque: no per-frame sort
        bm.perObjectFrustumCulled = false; // cull the whole tile batch by its bounds instead
        for (const { part, arr } of list) {
          const gid = bm.addGeometry(part.geometry);
          fill((_i, mtx, col) => { const id = bm.addInstance(gid); bm.setMatrixAt(id, mtx); bm.setColorAt(id, col); }, arr);
        }
        bm.computeBoundingBox();
        bm.computeBoundingSphere();
        mesh = bm;
      }
      mesh.castShadow = shadow;
      mesh.receiveShadow = key !== 'impostor';
      group.add(mesh);
    }
    for (const p of m.ponds as { x: number; z: number; r: number; level: number }[]) {
      const w = new THREE.Mesh(new THREE.CircleGeometry(p.r + 1.5, 24).rotateX(-Math.PI / 2), waterMaterial);
      w.position.set(p.x - tile.tx * TILE, p.level, p.z - tile.tz * TILE);
      w.receiveShadow = true;
      group.add(w);
    }
    return group;
  }

  private count(g: THREE.Group, sign: number) {
    this.tileCount += sign;
    this.grassCount += sign * (g.userData.grass ?? 0);
    this.propCount += sign * (g.userData.props ?? 0);
  }

  private disposeGroup(g: THREE.Group) {
    if (g.parent) this.count(g, -1);
    g.removeFromParent();
    g.traverse(o => {
      const mesh = o as THREE.Mesh;
      if ((mesh as any).isInstancedMesh || (mesh as any).isBatchedMesh) (mesh as any).dispose();
      else if (mesh.isMesh) mesh.geometry.dispose();
    });
  }

  private want(dist: number): { res: number; scenery: TileRequest['scenery'] } {
    const p = this.preset();
    const fine = p.terrainDetail === 1 ? 80 : 40;
    // ~5 m grid only near the camera; 12.5 m and 33 m further out (fog hides the rest)
    const res = dist < 450 ? fine : dist < 1200 ? 32 : 12;
    const scenery = dist < p.sceneryRange + TILE * 0.5 ? 'full' : dist < p.impostorRange ? 'impostor' : 'none';
    return { res, scenery };
  }

  update(cx: number, cz: number) {
    if (!this.workersReady) return;
    const p = this.preset();
    const R = p.drawDistance;
    const tr = Math.ceil(R / TILE);
    const ctx = Math.floor(cx / TILE), ctz = Math.floor(cz / TILE);
    const needed = new Set<string>();
    const requests: { tile: Tile; d: number }[] = [];
    for (let i = -tr; i <= tr; i++) for (let j = -tr; j <= tr; j++) {
      const tx = ctx + i, tz = ctz + j;
      const nx = Math.max(tx * TILE, Math.min(cx, (tx + 1) * TILE)), nz = Math.max(tz * TILE, Math.min(cz, (tz + 1) * TILE));
      const d = Math.hypot(nx - cx, nz - cz);
      if (d > R) continue;
      const key = `${tx},${tz}`;
      needed.add(key);
      let t = this.tiles.get(key);
      if (!t) { t = { key, tx, tz, res: 0, scenery: 'none', group: null, pendingId: 0, wantRes: 0, wantScenery: 'none' }; this.tiles.set(key, t); }
      const w = this.want(d);
      t.wantRes = w.res; t.wantScenery = w.scenery;
      // hysteresis: only rebuild if detail must go up, or is far too high
      const better = w.res > t.res || rank(w.scenery) > rank(t.scenery);
      const worse = !!t.group && (w.res * 2 < t.res || rank(w.scenery) + 1 < rank(t.scenery));
      if ((!t.group || better || worse) && !t.pendingId) requests.push({ tile: t, d });
    }
    for (const [key, t] of this.tiles) {
      if (needed.has(key)) continue;
      if (t.group) this.disposeGroup(t.group);
      this.tiles.delete(key);
    }
    requests.sort((a, b) => (a.tile.group ? 1 : 0) - (b.tile.group ? 1 : 0) || a.d - b.d);
    for (const { tile } of requests) {
      if (this.inFlight.size >= this.queueLimit) break;
      const id = this.nextId++;
      tile.pendingId = id;
      tile.res = tile.wantRes; tile.scenery = tile.wantScenery;
      this.inFlight.set(id, tile);
      const req: TileRequest = { type: 'tile', id, x0: tile.tx * TILE, z0: tile.tz * TILE, size: TILE, res: tile.wantRes, scenery: tile.wantScenery, grass: p.grassDensity };
      this.workers[this.rr++ % this.workers.length].postMessage(req);
    }
  }

  dispose() {
    for (const w of this.workers) w.terminate();
    for (const t of this.tiles.values()) if (t.group) this.disposeGroup(t.group);
    this.tiles.clear();
  }
}

const rank = (s: TileRequest['scenery']) => (s === 'full' ? 2 : s === 'impostor' ? 1 : 0);
