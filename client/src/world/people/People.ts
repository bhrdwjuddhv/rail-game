import * as THREE from 'three/webgpu';
import { WebGLRenderer, WebGLRenderTarget } from 'three';
import { newFrame } from '@rail/shared/track/Chainage';
import type { Route, StationInfo } from '@rail/shared/track/Route';
import { rng } from '@rail/shared/util';
import { PLATFORM_H } from '../../infrastructure/Station';

/**
 * Platform crowds from the baked character files (tools/people.mjs):
 *
 * - one InstancedMesh per character and level of detail; every person is
 *   animated on the GPU from a vertex animation texture (VAT), with its own
 *   clip, phase and clothing colours (instance attributes), so 150 people cost
 *   a handful of draws and no per-vertex work on the CPU;
 * - LOD by distance: full model (~2600 triangles), low model (~500), then a
 *   camera-facing picture of the character rendered once at load;
 * - spawned only around the station the train is near (within ~1.5 km), from
 *   a fixed budget per quality (High 90, Medium 60, Low / phones 20), and
 *   given back when the train leaves;
 * - simple behaviour on paths along the platform: wait facing the track, step
 *   back from the edge as a train comes in, walk to the doors and board when
 *   it stops, alight and walk off to the exit;
 * - models are fetched and built in the background after the run starts, one
 *   character per frame, shaders compiled before use (compileAsync). Without
 *   the files (or on the WebGPU renderer) the stations keep their simple crowd.
 */

interface ClipInfo { row: number; frames: number; fps: number }
interface ModelMeta { name: string; file: string; height: number; walkSpeed: number; clips: Record<string, ClipInfo>; lods: { vertices: number; indices: number; rowsPerFrame: number; width: number }[]; bytes: number }
interface Level { mesh: THREE.InstancedMesh; anim: THREE.InstancedBufferAttribute; tintA: THREE.InstancedBufferAttribute; tintB: THREE.InstancedBufferAttribute; n: number }
interface Model { meta: ModelMeta; levels: Level[]; sprite: { mesh: THREE.InstancedMesh; n: number; h: number } }
interface Person {
  model: number; x: number; y: number; z: number; heading: number;
  walking: boolean; tx: number; tz: number; then: 'idle' | 'gone'; phase: number;
  top: THREE.Color; bottom: THREE.Color; scale: number; edge: number; side: number; km: number; lat: number;
}
export interface Door { x: number; z: number; km: number }
export interface PlayerAtStation { code: string; stopped: boolean; approaching: boolean; doors: Door[]; platformLines: string[] }

const BASE = 'assets/models/_processed/people/';
const LOD_DIST = [40, 140, 420];
const CLOTHES = ['#c0392b', '#2471a3', '#1e8449', '#d4ac0d', '#7d3c98', '#e67e22', '#ecf0f1', '#17a589', '#e84393', '#34495e', '#a04000', '#f5b7b1', '#5d6d7e', '#82e0aa'];
const PANTS = ['#2c3e50', '#1b2631', '#5d4037', '#4a4a4a', '#283747', '#7b7d7d', '#d7ccc8', '#212f3c'];

export class PeopleSystem {
  readonly group = new THREE.Group();
  ready = false;
  private models: Model[] = [];
  private people: Person[] = [];
  private active: StationInfo | null = null;
  private time = { value: 0 };
  private r = rng(4242);
  private boarded = new Set<string>();
  private f = newFrame();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);

  constructor(private route: Route, private renderer: WebGLRenderer, private budget: number, private lodScale = 1) {
    this.group.name = 'people';
    this.group.matrixAutoUpdate = false;
  }

  /** Background load: manifest, then one character per frame. Resolves false when there are no models (simple crowds stay). */
  async load(camera: THREE.Camera, scene: THREE.Scene): Promise<boolean> {
    let list: ModelMeta[];
    try {
      const r = await fetch(BASE + 'people.json');
      if (!r.ok) return false;
      list = (await r.json()).models;
    } catch { return false; }
    if (!list?.length) return false;
    for (const meta of list) {
      try {
        const buf = await (await fetch(BASE + meta.file)).arrayBuffer();
        await nextFrame();
        const model = this.build(meta, buf);
        await this.renderer.compileAsync(model.levels[0].mesh, camera, scene).catch(() => {});
        this.models.push(model);
        for (const l of model.levels) this.group.add(l.mesh);
        this.group.add(model.sprite.mesh);
        await nextFrame();
      } catch (e) { console.warn(`[people] ${meta.name}: ${(e as Error).message}`); }
    }
    this.ready = this.models.length > 0;
    return this.ready;
  }

  // ------------------------------------------------------------------ building one character
  private build(meta: ModelMeta, buf: ArrayBuffer): Model {
    const dv = new DataView(buf);
    let o = 4 + dv.getUint32(0, true);
    const take = <T>(ctor: { new (b: ArrayBuffer, o: number, n: number): T; BYTES_PER_ELEMENT: number }, n: number) => {
      const a = new ctor(buf, o, n); o += n * ctor.BYTES_PER_ELEMENT; o = (o + 3) & ~3; return a;
    };
    const F = Object.values(meta.clips).reduce((a, c) => Math.max(a, c.row + c.frames), 0);
    const levels: Level[] = [];
    let spriteGeo: THREE.BufferGeometry | null = null;
    meta.lods.forEach((lod, li) => {
      const idx = take(Uint16Array, lod.indices);
      const col = take(Uint8Array, lod.vertices * 4);
      const texels = lod.width * lod.rowsPerFrame * F;
      const pos = take(Uint16Array, texels * 4);
      const nrm = take(Uint8Array, texels * 4);
      const geo = new THREE.BufferGeometry();
      // static attributes: the first idle frame (bounds, depth pass), colour (linear) and clothing mask
      const p0 = new Float32Array(lod.vertices * 3), c = new Float32Array(lod.vertices * 3), mask = new Float32Array(lod.vertices);
      for (let v = 0; v < lod.vertices; v++) {
        const t = ((Math.floor(v / lod.width)) * lod.width + (v % lod.width)) * 4;
        for (let k = 0; k < 3; k++) { p0[v * 3 + k] = THREE.DataUtils.fromHalfFloat(pos[t + k]); c[v * 3 + k] = srgbToLinear(col[v * 4 + k] / 255); }
        mask[v] = Math.round(col[v * 4 + 3] / 127);
      }
      geo.setAttribute('position', new THREE.BufferAttribute(p0, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
      geo.setAttribute('aMask', new THREE.BufferAttribute(mask, 1));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
      if (li === meta.lods.length - 1) spriteGeo = geo;
      const posTex = new THREE.DataTexture(pos, lod.width, lod.rowsPerFrame * F, THREE.RGBAFormat, THREE.HalfFloatType);
      const nrmTex = new THREE.DataTexture(nrm, lod.width, lod.rowsPerFrame * F, THREE.RGBAFormat, THREE.UnsignedByteType);
      for (const t of [posTex, nrmTex]) { t.needsUpdate = true; t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; }
      const anim = new THREE.InstancedBufferAttribute(new Float32Array(this.budget * 4), 4).setUsage(THREE.DynamicDrawUsage);
      const tintA = new THREE.InstancedBufferAttribute(new Float32Array(this.budget * 3), 3).setUsage(THREE.DynamicDrawUsage);
      const tintB = new THREE.InstancedBufferAttribute(new Float32Array(this.budget * 3), 3).setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aAnim', anim);
      geo.setAttribute('aTintA', tintA);
      geo.setAttribute('aTintB', tintB);
      const mat = vatMaterial(posTex, nrmTex, lod.width, lod.rowsPerFrame, this.time);
      const mesh = new THREE.InstancedMesh(geo, mat, this.budget);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false; // a few draws near one station; positions change every frame
      mesh.castShadow = li === 0;
      mesh.receiveShadow = true;
      mesh.name = `people-${meta.name}-lod${li}`;
      levels.push({ mesh, anim, tintA, tintB, n: 0 });
    });
    return { meta, levels, sprite: this.makeSprite(meta, spriteGeo!) };
  }

  /** A picture of the character (low model, first idle frame) on a camera-facing quad, for far away. */
  private makeSprite(meta: ModelMeta, geo: THREE.BufferGeometry) {
    const W = 64, H = 128, h = meta.height;
    const rt = new WebGLRenderTarget(W, H, { samples: 0 });
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(1, 2, 3); scene.add(sun);
    const body = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }));
    scene.add(body);
    const w = h * W / H;
    const cam = new THREE.OrthographicCamera(-w / 2, w / 2, h * 1.02, -h * 0.02, 0.1, 20);
    cam.position.set(0, 0, 10);
    const r = this.renderer, prevTarget = r.getRenderTarget(), prevClear = r.getClearAlpha(), prevColor = r.getClearColor(new THREE.Color());
    r.setRenderTarget(rt); r.setClearColor(0x000000, 0); r.clear(); r.render(scene, cam);
    r.setRenderTarget(prevTarget); r.setClearColor(prevColor, prevClear);
    (body.material as THREE.Material).dispose();
    const quad = new THREE.PlaneGeometry(w, h * 1.04).translate(0, h * 0.5, 0);
    const mesh = new THREE.InstancedMesh(quad, new THREE.MeshStandardMaterial({ map: rt.texture, alphaTest: 0.5, roughness: 1, side: THREE.DoubleSide }), this.budget);
    mesh.count = 0; mesh.frustumCulled = false; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.name = `people-${meta.name}-sprite`;
    return { mesh, n: 0, h };
  }

  // ------------------------------------------------------------------ crowd at one station
  /**
   * Called every frame. near: the station the train is at or approaching
   * (within ~1.5 km), or null; player: what the player's train is doing there.
   */
  update(dt: number, cam: THREE.Vector3, near: StationInfo | null, player: PlayerAtStation | null) {
    if (!this.ready) return;
    this.time.value += dt;
    if (near !== this.active) { this.people.length = 0; this.boarded.clear(); this.active = near; if (near) this.populate(near); }
    if (!this.active) { this.clearDraws(); return; }
    const st = this.active;
    // a train coming in: everyone near the edge steps back; when it stops, some board and some get off
    if (player && player.code === st.code) {
      if (player.approaching) for (const p of this.people) if (!p.walking && Math.abs(p.lat - p.edge) < 2.4) this.walkTo(p, p.km, p.edge + p.side * (3 + this.r() * 1.2), 'idle');
      const key = `${st.code}:${Math.floor(this.time.value / 600)}`;
      if (player.stopped && player.doors.length && !this.boarded.has(key)) {
        this.boarded.add(key);
        this.boardAndAlight(st, player);
      }
    }
    // move walkers
    for (let i = this.people.length - 1; i >= 0; i--) {
      const p = this.people[i];
      if (!p.walking) continue;
      const m = this.models[p.model].meta, dx = p.tx - p.x, dz = p.tz - p.z, d = Math.hypot(dx, dz), step = m.walkSpeed * p.scale * dt;
      if (d <= step) {
        p.x = p.tx; p.z = p.tz; p.walking = false;
        if (p.then === 'gone') { this.people.splice(i, 1); continue; }
        p.heading = this.faceTrack(p);
      } else { p.x += (dx / d) * step; p.z += (dz / d) * step; p.heading = Math.atan2(dx, dz); }
    }
    // top up a thinned crowd from the exit, a few at a time
    if (this.people.length < this.wanted(st) * 0.7 && this.r() < dt * 0.6) this.arrive(st);
    this.draw(cam);
  }

  /** crowd size 0..1 of the budget (Record Mode) */
  amount = 1;
  private wanted(st: StationInfo) {
    if (st.servicePlatformM) return Math.max(2, Math.round(this.budget * 0.05 * this.amount)); // freight crossing: a few staff
    return Math.round(this.budget * this.amount * (st.type === 'halt' ? 0.35 : st.type === 'wayside' ? 0.7 : 1));
  }

  private platformsOf(st: StationInfo) {
    const from = st.servicePlatformM ? st.km - st.servicePlatformM / 2000 : st.platformFromKm;
    const to = st.servicePlatformM ? st.km + st.servicePlatformM / 2000 : st.platformToKm;
    return st.platforms.map(p => ({ p, from, to, side: Math.sign(p.to - p.from) || 1, width: Math.abs(p.to - p.from) }));
  }

  private populate(st: StationInfo) {
    const plats = this.platformsOf(st);
    const n = this.wanted(st);
    for (let i = 0; i < n; i++) {
      const pl = plats[i % plats.length];
      // denser towards the middle (shelters, building)
      const u = (this.r() + this.r() + this.r()) / 3;
      const km = pl.from + 0.02 + u * (pl.to - pl.from - 0.04);
      const lat = pl.p.from + pl.side * (1.8 + this.r() * Math.max(0.5, pl.width - 2.6));
      const p = this.spawn(km, lat, pl.p.from, pl.side);
      // a few pace up and down
      if (this.r() < 0.15) this.walkTo(p, km + (this.r() - 0.5) * 0.04, lat, 'idle');
    }
  }

  private spawn(km: number, lat: number, edge: number, side: number): Person {
    this.route.alignment.sampleOffset(km * 1000, lat, this.f);
    const r = this.r;
    const p: Person = {
      model: Math.floor(r() * this.models.length), x: this.f.x, y: this.f.y + PLATFORM_H, z: this.f.z, heading: 0,
      walking: false, tx: this.f.x, tz: this.f.z, then: 'idle', phase: r() * 30,
      top: new THREE.Color(CLOTHES[Math.floor(r() * CLOTHES.length)]).convertSRGBToLinear(),
      bottom: new THREE.Color(PANTS[Math.floor(r() * PANTS.length)]).convertSRGBToLinear(),
      scale: 0.93 + r() * 0.12, edge, side, km, lat,
    };
    p.heading = this.faceTrack(p) + (r() - 0.5) * 1.4;
    this.people.push(p);
    return p;
  }

  /** Facing the track (towards the platform edge). */
  private faceTrack(p: Person) {
    this.route.alignment.sample(p.km * 1000, this.f);
    const nx = -Math.sin(this.f.heading), nz = Math.cos(this.f.heading); // +lateral
    return Math.atan2(-nx * p.side, -nz * p.side);
  }

  private walkTo(p: Person, km: number, lat: number, then: 'idle' | 'gone') {
    this.route.alignment.sampleOffset(km * 1000, lat, this.f);
    p.tx = this.f.x; p.tz = this.f.z; p.km = km; p.lat = lat; p.walking = true; p.then = then;
  }

  private boardAndAlight(st: StationInfo, player: PlayerAtStation) {
    const plats = this.platformsOf(st).filter(pl => pl.p.lines.some(l => player.platformLines.includes(l)));
    if (!plats.length) return;
    const pl = plats[0];
    // boarders: a quarter of those on this platform walk to the nearest door and get in
    const here = this.people.filter(p => p.edge === pl.p.from);
    for (const p of here) {
      if (this.r() > 0.25) continue;
      const door = player.doors.reduce((b, d) => (Math.abs(d.km - p.km) < Math.abs(b.km - p.km) ? d : b));
      this.walkTo(p, door.km, pl.p.from + pl.side * 0.4, 'gone');
    }
    // alighting passengers walk off towards the back of the platform at the middle (building, footbridge)
    const off = Math.min(Math.max(2, Math.round(this.budget * 0.08)), player.doors.length * 2);
    for (let i = 0; i < off; i++) {
      const door = player.doors[Math.floor(this.r() * player.doors.length)];
      const p = this.spawn(door.km + (this.r() - 0.5) * 0.002, pl.p.from + pl.side * 0.6, pl.p.from, pl.side);
      p.phase = this.r() * 5;
      this.walkTo(p, st.km + (this.r() - 0.5) * 0.05, pl.p.to - pl.side * 0.8, 'gone');
    }
  }

  /** A newcomer walks in from the back of the platform to a waiting spot. */
  private arrive(st: StationInfo) {
    const plats = this.platformsOf(st);
    const pl = plats[Math.floor(this.r() * plats.length)];
    const p = this.spawn(st.km + (this.r() - 0.5) * 0.04, pl.p.to - pl.side * 0.8, pl.p.from, pl.side);
    this.walkTo(p, pl.from + 0.03 + this.r() * (pl.to - pl.from - 0.06), pl.p.from + pl.side * (2 + this.r() * Math.max(0.5, pl.width - 2.8)), 'idle');
  }

  // ------------------------------------------------------------------ instance buffers
  private clearDraws() {
    for (const m of this.models) { for (const l of m.levels) l.mesh.count = 0; m.sprite.mesh.count = 0; }
  }

  private draw(cam: THREE.Vector3) {
    for (const m of this.models) { for (const l of m.levels) l.n = 0; m.sprite.n = 0; }
    const d0 = LOD_DIST[0] * this.lodScale, d1 = LOD_DIST[1] * this.lodScale, d2 = LOD_DIST[2];
    for (const p of this.people) {
      const model = this.models[p.model];
      const d = Math.hypot(p.x - cam.x, p.y - cam.y, p.z - cam.z);
      if (d > d2) continue;
      this.s.setScalar(p.scale);
      if (d > d1) {
        const sp = model.sprite;
        this.q.setFromAxisAngle(this.up, Math.atan2(cam.x - p.x, cam.z - p.z));
        sp.mesh.setMatrixAt(sp.n++, this.m.compose(this.v.set(p.x, p.y, p.z), this.q, this.s));
        continue;
      }
      const l = model.levels[d > d0 ? 1 : 0], i = l.n++;
      this.q.setFromAxisAngle(this.up, p.heading);
      l.mesh.setMatrixAt(i, this.m.compose(this.v.set(p.x, p.y, p.z), this.q, this.s));
      const c = model.meta.clips[p.walking ? 'walk' : 'idle'] ?? model.meta.clips.idle;
      // walk cycle speed follows the person's scale (longer legs: same cadence, longer stride)
      l.anim.setXYZW(i, c.row, c.frames, c.fps, p.phase);
      l.tintA.setXYZ(i, p.top.r, p.top.g, p.top.b);
      l.tintB.setXYZ(i, p.bottom.r, p.bottom.g, p.bottom.b);
    }
    for (const m of this.models) {
      for (const l of m.levels) {
        l.mesh.count = l.n;
        if (l.n) { l.mesh.instanceMatrix.needsUpdate = true; l.anim.needsUpdate = true; l.tintA.needsUpdate = true; l.tintB.needsUpdate = true; }
      }
      m.sprite.mesh.count = m.sprite.n;
      if (m.sprite.n) m.sprite.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  get count() { return this.people.length; }
  get triangles() { return this.models.reduce((a, m) => a + m.levels.reduce((b, l, i) => b + l.mesh.count * m.meta.lods[i].indices / 3, 0) + m.sprite.mesh.count * 2, 0); }
}

/** MeshStandardMaterial that takes each vertex's position and normal from the VAT (per-instance clip, frame and phase). */
function vatMaterial(pos: THREE.Texture, nrm: THREE.Texture, width: number, rowsPerFrame: number, time: { value: number }) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
  m.onBeforeCompile = s => {
    s.uniforms.uVatPos = { value: pos };
    s.uniforms.uVatNrm = { value: nrm };
    s.uniforms.uVat = { value: new THREE.Vector2(width, rowsPerFrame) };
    s.uniforms.uTime = time;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>
uniform sampler2D uVatPos; uniform sampler2D uVatNrm; uniform vec2 uVat; uniform float uTime;
attribute vec4 aAnim; attribute vec3 aTintA; attribute vec3 aTintB; attribute float aMask;
ivec2 vatTexel(int v, float f) { int w = int(uVat.x); return ivec2(v % w, int(f) * int(uVat.y) + v / w); }`)
      .replace('#include <beginnormal_vertex>', `float vatF = mod((uTime + aAnim.w) * aAnim.z, aAnim.y);
float vatF0 = floor(vatF), vatF1 = mod(vatF0 + 1.0, aAnim.y), vatK = vatF - vatF0;
vec3 objectNormal = normalize(mix(texelFetch(uVatNrm, vatTexel(gl_VertexID, aAnim.x + vatF0), 0).xyz, texelFetch(uVatNrm, vatTexel(gl_VertexID, aAnim.x + vatF1), 0).xyz, vatK) * 2.0 - 1.0);`)
      .replace('#include <begin_vertex>', `vec3 transformed = mix(texelFetch(uVatPos, vatTexel(gl_VertexID, aAnim.x + vatF0), 0).xyz, texelFetch(uVatPos, vatTexel(gl_VertexID, aAnim.x + vatF1), 0).xyz, vatK);`)
      .replace('#include <color_vertex>', `#include <color_vertex>
// clothing (mask 1 = top, 2 = bottom) takes the person's colours, keeping the texture's shading
float vatLum = dot(vColor.rgb, vec3(0.3, 0.59, 0.11));
vColor.rgb = mix(vColor.rgb, (aMask > 1.5 ? aTintB : aTintA) * (vatLum * 1.6 + 0.12), step(0.5, aMask));`);
  };
  m.customProgramCacheKey = () => 'people-vat-1';
  return m;
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const nextFrame = () => new Promise<void>(r => requestAnimationFrame(() => r()));
