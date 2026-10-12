import * as THREE from 'three/webgpu';
import { tex } from '../core/Textures';
import { settings } from '../core/Settings';
import { newFrame } from '@rail/shared/track/Chainage';
import { waterfallCliff, type Route } from '@rail/shared/track/Route';
import { waterMaterial } from './ChunkManager';
import type { TerrainField } from './TerrainField';

/** River surfaces: one flat ribbon per river at its water level. */
export function buildRivers(route: Route): THREE.Group {
  const g = new THREE.Group();
  for (const r of route.rivers) {
    const P = r.points;
    const pos: number[] = [], idx: number[] = [];
    const ox = P[0].x, oz = P[0].z;
    const half = r.width / 2 + 20;
    for (let i = 0; i < P.length; i++) {
      const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)];
      const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz) || 1;
      const nx = -dz / L, nz = dx / L;
      pos.push(P[i].x + nx * half - ox, r.water, P[i].z + nz * half - oz, P[i].x - nx * half - ox, r.water, P[i].z - nz * half - oz);
      if (i > 0) { const k = (i - 1) * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    }
    // wound to face up whichever way the river runs: a back face would be lit from below (black)
    const ax = pos[3] - pos[0], az = pos[5] - pos[2], bx = pos[6] - pos[0], bz = pos[8] - pos[2];
    if (az * bx - ax * bz < 0) for (let t = 0; t < idx.length; t += 3) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    // force normals up regardless of winding
    const n = geo.attributes.normal as THREE.BufferAttribute;
    for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, waterMaterial);
    m.position.set(ox, 0, oz);
    m.receiveShadow = true;
    m.name = r.id;
    g.add(m);
  }
  return g;
}

/** Mist puffs per waterfall by quality preset (mobile: very light). */
const MIST: Record<string, number> = { low: 8, medium: 24, high: 48, ultra: 48 };
const MIST_LIFE = 4.5;

interface Fall { base: THREE.Vector3; out: THREE.Vector3; mist: THREE.Points; age: Float32Array; seed: Float32Array }

/**
 * Waterfalls (route features): a sheet of water that bends over the lip and
 * spreads as it falls (a scrolling texture), a foam pool at its foot, mist
 * rising from the pool, and a roar (see Ambience). A waterfall with an offsetM in
 * the data falls down a cliff the route cuts for it (Route: features ->
 * landforms); without one it is placed on the uphill side of the line.
 */
export class Waterfalls {
  readonly group = new THREE.Group();
  /** pool positions (world), for the roar */
  readonly positions: THREE.Vector3[] = [];
  private tex: THREE.Texture;
  private falls: Fall[] = [];

  constructor(route: Route, field: TerrainField) {
    this.tex = tex.waterfall().clone();
    this.tex.wrapS = this.tex.wrapT = THREE.RepeatWrapping;
    this.tex.needsUpdate = true;
    const mat = new THREE.MeshStandardMaterial({ map: this.tex, transparent: true, opacity: 0.88, roughness: 0.3, side: THREE.DoubleSide, depthWrite: false, emissive: 0x99aab0, emissiveIntensity: 0.18 });
    const foamMat = new THREE.MeshStandardMaterial({ color: 0xe8f0f2, transparent: true, opacity: 0.75, roughness: 0.5, depthWrite: false });
    const mistMat = new THREE.PointsMaterial({ map: mistTexture(), size: 11, sizeAttenuation: true, transparent: true, opacity: 0.32, depthWrite: false, color: 0xf2f6f8 });
    const nMist = MIST[settings.get().quality] ?? 24;
    const f = newFrame();
    for (const feat of route.data.features) {
      if (feat.type !== 'waterfall') continue;
      const s0 = feat.km * 1000;
      let side: number, lip: number, foot: number;
      if (feat.offsetM !== undefined) {
        // the route cut a cliff for it: face from foot (toward the line) to lip
        ({ side, lip, foot } = waterfallCliff(feat));
      } else {
        route.alignment.sampleOffset(s0, 160, f);
        const up = field.height(f.x, f.z);
        route.alignment.sampleOffset(s0, -160, f);
        side = field.height(f.x, f.z) > up ? -1 : 1; lip = side * 120; foot = side * 70;
      }
      route.alignment.sampleOffset(s0, lip + side * 3, f);
      const topY = field.height(f.x, f.z);
      route.alignment.sampleOffset(s0, foot - side * 2, f);
      const footY = field.height(f.x, f.z), fx = f.x, fz = f.z;
      const H = Math.max(12, topY - footY);
      // toward the line from the cliff: the sheet arcs out that way
      const out = new THREE.Vector3(Math.sin(f.heading) * side, 0, -Math.cos(f.heading) * side);
      // anchored at the foot of the cliff; the water runs down the face from the lip
      const sheet = new THREE.Mesh(fallGeometry(H, Math.abs(lip - foot)), mat);
      sheet.position.set(fx, footY, fz);
      sheet.rotation.y = Math.atan2(out.x, out.z);
      this.group.add(sheet);
      const base = new THREE.Vector3(fx, footY, fz);
      const foam = new THREE.Mesh(new THREE.CircleGeometry(8, 20).rotateX(-Math.PI / 2), foamMat);
      foam.position.set(fx, footY + 0.5, fz);
      this.group.add(foam);
      const mist = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(nMist * 3), 3)), mistMat);
      mist.frustumCulled = false;
      this.group.add(mist);
      const age = new Float32Array(nMist), seed = new Float32Array(nMist);
      for (let i = 0; i < nMist; i++) { age[i] = (i / nMist) * MIST_LIFE; seed[i] = Math.random(); }
      this.falls.push({ base, out, mist, age, seed });
      this.positions.push(base);
    }
  }

  update(dt: number, visible: boolean) {
    this.group.visible = visible;
    if (!visible) return;
    this.tex.offset.y += dt * 1.6;
    for (const fl of this.falls) {
      const p = fl.mist.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < fl.age.length; i++) {
        fl.age[i] = (fl.age[i] + dt) % MIST_LIFE;
        const t = fl.age[i] / MIST_LIFE, a = fl.seed[i] * Math.PI * 2, r = 2 + t * 9;
        // puffs billow out from the pool and up, drifting toward the line
        p.setXYZ(i, fl.base.x + Math.cos(a) * r + fl.out.x * t * 6, fl.base.y + 1 + t * 10 + fl.seed[i] * 2, fl.base.z + Math.sin(a) * r + fl.out.z * t * 6);
      }
      p.needsUpdate = true;
    }
  }
}

/**
 * The water: local +z toward the line, origin at the foot of the cliff. It pours
 * over the lip (reach behind the foot), then runs down the face a metre or two
 * clear of the rock, spreading as it falls.
 */
function fallGeometry(H: number, reach: number) {
  const N = 12, pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const z = -reach * (1 - t) + 1 + 1.6 * Math.sin(Math.PI * Math.min(1, t * 1.3)), y = H * (1 - t) + 0.4, w = 3.5 + 3 * t;
    pos.push(-w, y, z, w, y, z);
    uv.push(0, (1 - t) * H / 22, 1, (1 - t) * H / 22);
    if (i > 0) { const k = (i - 1) * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

let mistTex: THREE.Texture | null = null;
function mistTexture() {
  if (mistTex) return mistTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!, gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  mistTex = new THREE.CanvasTexture(c);
  mistTex.colorSpace = THREE.SRGBColorSpace;
  return mistTex;
}
