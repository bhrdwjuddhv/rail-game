import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { smoothstep } from '@rail/shared/util';
import { tex } from '../core/Textures';
import { assets } from '../core/AssetRegistry';
import { newFrame, RAIL_TOP, TrackFrame } from '@rail/shared/track/Chainage';
import type { Route } from '@rail/shared/track/Route';
import { RAMP_M, Switch } from '@rail/shared/track/TrackGraph';

export const CHUNK_M = 400; // longer chunks = fewer draw calls (each chunk is ~3 draws)
const SLEEPER_SPACING = 0.65;
const RAIL_C = 0.8735; // rail centre from track centre (1676 mm gauge + half head)

/** A piece of track inside one chunk: s range (m) and lateral offset function. */
export interface TrackPiece { s0: number; s1: number; offset: (s: number) => number; kind: 'main' | 'line' | 'ramp' }

export function piecesIn(route: Route, s0: number, s1: number): TrackPiece[] {
  const out: TrackPiece[] = [{ s0, s1, offset: () => 0, kind: 'main' }];
  for (const l of route.graph.lines) {
    if (l.id === 'main') continue;
    const a = Math.max(s0, l.fromKm * 1000), b = Math.min(s1, l.toKm * 1000);
    if (b > a) out.push({ s0: a, s1: b, offset: () => l.offset, kind: 'line' });
  }
  for (const sw of route.graph.switches) {
    const d = sw.def;
    const a = Math.max(s0, d.rampStart * 1000), b = Math.min(s1, d.rampEnd * 1000);
    if (b > a) out.push({ s0: a, s1: b, offset: s => d.from + (d.to - d.from) * smoothstep(d.rampStart * 1000, d.rampEnd * 1000, s), kind: 'ramp' });
  }
  return out;
}

/** Frame on a piece, heading corrected for the lateral slope of ramps. */
export function pieceFrame(route: Route, p: TrackPiece, s: number, out: TrackFrame) {
  const o = p.offset(s);
  route.alignment.sampleOffset(s, o, out);
  if (p.kind === 'ramp') out.heading += Math.atan2(p.offset(s + 0.5) - p.offset(s - 0.5), 1);
  return out;
}

export class Strip {
  pos: number[] = []; nor: number[] = []; uv: number[] = []; idx: number[] = [];
  /** Add a profile extruded along frames; profile points are (lateral, up). */
  extrude(frames: TrackFrame[], ss: number[], profile: [number, number][], ox: number, oz: number, uScale: number, vScale: number, closed = false) {
    const segs = closed ? profile.length : profile.length - 1;
    for (let e = 0; e < segs; e++) {
      const p0 = profile[e], p1 = profile[(e + 1) % profile.length];
      const base = this.pos.length / 3;
      // flat normal of this profile edge, in (lateral, up) space
      let nl = p1[1] - p0[1], nu = -(p1[0] - p0[0]);
      const L = Math.hypot(nl, nu) || 1; nl /= L; nu /= L;
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        const ch = Math.cos(f.heading), sh = Math.sin(f.heading), cc = Math.cos(f.cant), sc = Math.sin(f.cant);
        for (const [lat0, up0] of [p0, p1]) {
          const lat = lat0 * cc + up0 * sc, up = up0 * cc - lat0 * sc;
          this.pos.push(f.x - sh * lat - ox, f.y + up, f.z + ch * lat - oz);
          this.uv.push((lat0 + up0) * uScale, ss[i] * vScale);
        }
        const nlat = nl * cc + nu * sc, nup = nu * cc - nl * sc;
        for (let k = 0; k < 2; k++) this.nor.push(-sh * nlat, nup, ch * nlat);
      }
      for (let i = 0; i < frames.length - 1; i++) {
        const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
        this.idx.push(a, c, b, b, c, d);
      }
    }
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

// 8-edge rail section (foot, web, head): enough detail at cab distance, a third fewer triangles than 12 edges
const RAIL_PROFILE: [number, number][] = [
  [-0.07, 0], [0.07, 0], [0.012, 0.03], [0.036, 0.13], [0.036, 0.172], [-0.036, 0.172], [-0.036, 0.13], [-0.012, 0.03],
];
const BALLAST_PROFILE: [number, number][] = [[-2.7, -0.02], [-1.75, 0.33], [1.75, 0.33], [2.7, -0.02]];
const RAIL_BASE = RAIL_TOP - 0.172;

function sleeperGeometry() {
  const b = new THREE.BoxGeometry(0.25, 0.21, 2.75);
  // BoxGeometry groups: +x, -x, +y, -y, +z, -z (6 indices per face pair of triangles)
  const idx = b.index!.array as ArrayLike<number>;
  const keep: number[] = [];
  for (const face of [0, 1, 2]) for (let i = 0; i < 6; i++) keep.push(idx[face * 6 + i]);
  b.setIndex(keep);
  b.clearGroups();
  return b;
}

let shared: { rail: THREE.Material; ballast: THREE.Material; sleeper: THREE.Material; sleeperGeo: THREE.BufferGeometry; plate: THREE.BufferGeometry } | null = null;
function sharedAssets() {
  if (shared) return shared;
  const rail = new THREE.MeshStandardMaterial({ color: 0x8a8580, metalness: 0.75, roughness: 0.38 });
  const ballast = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 });
  assets.bindTextureSet(ballast, 'track/ballast', tex.ballast, 2); // ballast strip UVs: 1 unit = 2 m
  const sleeper = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
  assets.bindTextureSet(sleeper, 'track/sleeper', tex.concrete, 1);
  // top + two long sides only: the bottom and the ends are never visible
  const sleeperGeo = sleeperGeometry();
  const plate = new THREE.BoxGeometry(0.6, 0.1, 0.03);
  shared = { rail, ballast, sleeper, sleeperGeo, plate };
  return shared;
}

/** Build one 200 m chunk of track: ballast, rails, sleepers, fishplates. */
export function buildTrackChunk(route: Route, index: number): THREE.Group {
  const S = sharedAssets();
  const s0 = index * CHUNK_M, s1 = Math.min(route.alignment.length, s0 + CHUNK_M);
  const group = new THREE.Group();
  const origin = newFrame();
  route.alignment.sample(s0, origin);
  group.position.set(origin.x, 0, origin.z);
  const ox = origin.x, oz = origin.z;

  const ballast = new Strip(), rails = new Strip();
  const sleeperMats: THREE.Matrix4[] = [];
  const sleeperCols: THREE.Color[] = [];
  const plateMats: THREE.Matrix4[] = [];
  const f = newFrame();
  const q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  const wood = new THREE.Color(0x6b4f35), conc = new THREE.Color(0xffffff);

  for (const piece of piecesIn(route, s0, s1)) {
    const frames: TrackFrame[] = [], ss: number[] = [];
    // 2 m steps on curves and turnouts, 5 m on straight track
    const straight = piece.kind !== 'ramp' && Math.abs(route.alignment.curvatureAt((piece.s0 + piece.s1) / 2000)) < 1 / 3000 && Math.abs(route.alignment.curvatureAt(piece.s0 / 1000)) < 1 / 3000 && Math.abs(route.alignment.curvatureAt(piece.s1 / 1000)) < 1 / 3000;
    const steps = Math.max(1, Math.ceil((piece.s1 - piece.s0) / (straight ? 5 : 2)));
    for (let i = 0; i <= steps; i++) {
      const s = piece.s0 + ((piece.s1 - piece.s0) * i) / steps;
      frames.push({ ...pieceFrame(route, piece, s, f) });
      ss.push(s - s0); // chunk-local: small UV numbers, seamless since 400 m chunks are a multiple of the tiling
    }
    const km = (piece.s0 + piece.s1) / 2000;
    const st = route.structureAt(km);
    const openDeck = st?.type === 'bridge' && st.style !== 'arch-viaduct';
    // ballast (ramps slightly lower so the through road wins where they overlap)
    if (!openDeck) {
      const prof = piece.kind === 'ramp' ? BALLAST_PROFILE.map(([a, b]) => [a, b - 0.012] as [number, number]) : BALLAST_PROFILE;
      ballast.extrude(frames, ss, prof, ox, oz, 0.5, 0.5);
    }
    for (const side of [-1, 1]) {
      rails.extrude(frames, ss, RAIL_PROFILE.map(([a, b]) => [a + side * RAIL_C, b + RAIL_BASE] as [number, number]), ox, oz, 1, 0.1, true);
    }
    // sleepers
    const first = Math.ceil(piece.s0 / SLEEPER_SPACING) * SLEEPER_SPACING;
    for (let s = first; s < piece.s1; s += SLEEPER_SPACING) {
      if (piece.kind === 'ramp') {
        const o = piece.offset(s);
        const covered = route.graph.lines.some(l => Math.abs(l.offset - o) < 1.3 && s / 1000 >= l.fromKm && s / 1000 <= l.toKm);
        if (covered) continue;
      }
      pieceFrame(route, piece, s, f);
      e.set(f.cant, -f.heading, 0, 'YXZ');
      q.setFromEuler(e);
      p.set(f.x - ox, f.y + RAIL_BASE - 0.1, f.z - oz);
      sleeperMats.push(new THREE.Matrix4().compose(p.clone(), q.clone(), one));
      sleeperCols.push(openDeck ? wood : conc);
    }
    // fishplates at joints every 26 m (main and loop lines)
    if (piece.kind !== 'ramp') {
      for (let s = Math.ceil(piece.s0 / 26) * 26; s < piece.s1; s += 26) {
        pieceFrame(route, piece, s, f);
        e.set(f.cant, -f.heading, 0, 'YXZ');
        q.setFromEuler(e);
        const ch = Math.cos(f.heading), sh = Math.sin(f.heading);
        for (const lat of [-RAIL_C - 0.025, -RAIL_C + 0.025, RAIL_C - 0.025, RAIL_C + 0.025]) {
          p.set(f.x - sh * lat - ox, f.y + RAIL_BASE + 0.07, f.z + ch * lat - oz);
          plateMats.push(new THREE.Matrix4().compose(p.clone(), q.clone(), one));
        }
      }
    }
  }

  if (ballast.pos.length) {
    const m = new THREE.Mesh(ballast.geometry(), S.ballast);
    m.receiveShadow = true;
    group.add(m);
  }
  // rails + fishplates in one draw (plates are tiny; merged as plain geometry)
  const parts = [rails.geometry()];
  for (const m of plateMats) {
    const g = S.plate.clone().applyMatrix4(m);
    g.deleteAttribute('uv');
    parts.push(g);
  }
  for (const g of parts) if (g.attributes.uv) g.deleteAttribute('uv');
  const railGeo = mergeGeometries(parts, false)!;
  railGeo.computeBoundingSphere();
  const rm = new THREE.Mesh(railGeo, S.rail);
  rm.castShadow = true;
  group.add(rm);
  if (sleeperMats.length) {
    const im = new THREE.InstancedMesh(S.sleeperGeo, S.sleeper, sleeperMats.length);
    sleeperMats.forEach((m, i) => { im.setMatrixAt(i, m); im.setColorAt(i, sleeperCols[i]); });
    im.receiveShadow = true;
    im.computeBoundingBox();
    im.computeBoundingSphere();
    group.add(im);
  }
  return group;
}

/**
 * Animated switch blades + point indicator for one turnout. The two switch
 * rails slide across by the throw of the point machine.
 */
export class SwitchView {
  readonly group = new THREE.Group();
  private blades: THREE.Mesh[] = [];
  private lamp: THREE.Mesh;
  private lampMat: THREE.MeshBasicMaterial;

  constructor(route: Route, readonly sw: Switch) {
    const d = sw.def;
    const toeKm = d.kind === 'trailing' ? d.rampEnd : d.rampStart;
    const throughOffset = d.kind === 'trailing' ? d.to : d.from;
    const f = newFrame();
    route.alignment.sampleOffset(toeKm * 1000, throughOffset, f);
    this.group.position.set(f.x, f.y + RAIL_BASE, f.z);
    this.group.rotation.set(0, -f.heading, 0);
    const dir = d.kind === 'trailing' ? -1 : 1; // blades point away from the toe
    const geo = new THREE.BoxGeometry(9, 0.15, 0.06);
    const m = new THREE.MeshStandardMaterial({ color: 0x9a948e, metalness: 0.75, roughness: 0.35 });
    for (const side of [-1, 1]) {
      const b = new THREE.Mesh(geo, m);
      b.position.set(dir * 4.5, 0.08, side * (RAIL_C - 0.06));
      b.castShadow = true;
      this.group.add(b);
      this.blades.push(b);
    }
    // point indicator on a short post beside the toe
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.1, 6), new THREE.MeshStandardMaterial({ color: 0x333333 }));
    const side = Math.sign(d.to - d.from) || 1;
    post.position.set(-1.5 * dir, 0.55, -side * 2.4);
    this.group.add(post);
    this.lampMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.lamp = new THREE.Mesh(new THREE.CircleGeometry(0.16, 12), this.lampMat);
    this.lamp.position.set(-1.5 * dir - 0.05 * dir, 1.15, -side * 2.4);
    this.lamp.rotation.y = dir > 0 ? -Math.PI / 2 : Math.PI / 2;
    this.group.add(this.lamp);
    this.sideSign = side;
  }
  private sideSign: number;

  update() {
    const t = this.sw.throw; // 0 normal .. 1 reverse
    const shift = (t - 0.5) * 0.12 * this.sideSign;
    for (const b of this.blades) b.position.z = Math.sign(b.position.z) * (RAIL_C - 0.06) + shift;
    this.lampMat.color.set(this.sw.moving ? 0x555555 : t > 0.5 ? 0xffc400 : 0xf2f2f2);
  }
}

export { RAMP_M };
