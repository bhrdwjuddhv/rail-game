import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { smoothstep } from '@rail/shared/util';
import { tex } from '../core/Textures';
import { textures } from '../core/TextureLibrary';
import { newFrame, RAIL_TOP, TrackFrame } from '@rail/shared/track/Chainage';
import type { Route } from '@rail/shared/track/Route';
import type { Railway } from '@rail/shared/track/Railway';
import { RAMP_M, Switch, SwitchDef } from '@rail/shared/track/TrackGraph';

export const CHUNK_M = 400; // longer chunks = fewer draw calls (each chunk is ~3 draws)
const SLEEPER_SPACING = 0.65;
const SLEEPER_LEN = 2.75;
const RAIL_C = 0.8735; // rail centre from track centre (1676 mm gauge + half head)

/** A piece of track inside one chunk: s range (m) and lateral offset function. */
export interface TrackPiece { s0: number; s1: number; offset: (s: number) => number; kind: 'main' | 'line' | 'ramp'; sw?: SwitchDef }

/** Every track of both directions in [s0, s1): running lines, loops and turnout ramps. */
export function piecesIn(railway: Railway, s0: number, s1: number): TrackPiece[] {
  const out: TrackPiece[] = [];
  const running = new Set(railway.main.runningLines.map(l => l.id));
  for (const l of railway.layout.lines) {
    const a = Math.max(s0, l.fromKm * 1000), b = Math.min(s1, l.toKm * 1000);
    if (b > a) out.push({ s0: a, s1: b, offset: () => l.offset, kind: running.has(l.id) ? 'main' : 'line' });
  }
  for (const sw of railway.layout.switches) {
    const d = sw.def;
    const a = Math.max(s0, d.rampStart * 1000), b = Math.min(s1, d.rampEnd * 1000);
    if (b > a) out.push({ s0: a, s1: b, offset: s => d.from + (d.to - d.from) * smoothstep(d.rampStart * 1000, d.rampEnd * 1000, s), kind: 'ramp', sw: d });
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
    // white vertex colours: the shared textured materials use vertexColors, and a
    // missing colour attribute reads whatever the last draw left (often black)
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(this.pos.length).fill(1), 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

// 8-edge rail section (foot, web, head): enough detail at cab distance, a third fewer triangles than 12 edges
const RAIL_PROFILE: [number, number][] = [
  [-0.07, 0], [0.07, 0], [0.012, 0.03], [0.036, 0.13], [0.036, 0.172], [-0.036, 0.172], [-0.036, 0.13], [-0.012, 0.03],
];
/**
 * Ballast bed cross-section (lateral, up from formation): a trapezoid with a
 * 3.4 m top. Its top is 40 cm up so the 21 cm sleepers sit in it with about
 * 6 cm showing; the toes go 6 cm under the ground (formation - 5 cm) so no gap
 * shows. Listed counter-clockwise (right toe, over the top, left toe) like
 * every extruded profile, so the faces point outward.
 */
const BED_TOP = 0.4, BED_HALF = 1.7, BED_TOE = 2.45, BED_TOE_Y = -0.06;
const BALLAST_PROFILE: [number, number][] = [[BED_TOE, BED_TOE_Y], [BED_HALF, BED_TOP], [-BED_HALF, BED_TOP], [-BED_TOE, BED_TOE_Y]];
const RAIL_BASE = RAIL_TOP - 0.172;

function sleeperGeometry() {
  const b = new THREE.BoxGeometry(0.25, 0.21, SLEEPER_LEN);
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
  textures.bind(ballast, 'ballast', tex.ballast, 2, { resident: true }); // ballast strip UVs: 1 unit = 2 m
  const sleeper = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
  textures.bind(sleeper, 'sleeper', tex.concrete, 1, { resident: true });
  // top + two long sides only: the bottom and the ends are never visible
  const sleeperGeo = sleeperGeometry();
  const plate = new THREE.BoxGeometry(0.6, 0.1, 0.03);
  shared = { rail, ballast, sleeper, sleeperGeo, plate };
  return shared;
}

/**
 * Ballast between the two running lines of a double line, so the formation is
 * one bed with shoulders on the outer sides only. Each edge follows the top of
 * the neighbouring track's ballast (which is canted about its own centre).
 */
function infill(route: Route, s0: number, s1: number, h: number, ox: number, oz: number, out: Strip) {
  const step = 5, f = newFrame();
  const n = Math.max(1, Math.ceil((s1 - s0) / step));
  const base = out.pos.length / 3;
  const top = BED_TOP - 0.006; // just under the tracks' own beds where they meet
  for (let i = 0; i <= n; i++) {
    const s = s0 + ((s1 - s0) * i) / n;
    route.alignment.sample(s, f);
    const ch = Math.cos(f.heading), sh = Math.sin(f.heading), sc = Math.sin(f.cant), cc = Math.cos(f.cant);
    // inner shoulder of the right track (lat -BED_HALF from +h), then of the left track: right to left, so the face points up
    for (const [lat, rel] of [[h - BED_HALF, -BED_HALF], [-h + BED_HALF, BED_HALF]] as const) {
      const centre = lat - rel;
      const up = top * cc - rel * sc, l2 = centre + rel * cc + top * sc;
      out.pos.push(f.x - sh * l2 - ox, f.y + up, f.z + ch * l2 - oz);
      out.nor.push(0, 1, 0);
      out.uv.push(l2 * 0.5, (s - s0) * 0.5);
    }
    if (i > 0) { const a = base + (i - 1) * 2; out.idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
}

/** Build one 400 m chunk of track (every line in it): ballast, rails, sleepers, fishplates. */
export function buildTrackChunk(railway: Railway, index: number): THREE.Group {
  const route = railway.main;
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

  for (const piece of piecesIn(railway, s0, s1)) {
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
    // ballast. A crossover between the two running lines lies wholly on their
    // shared bed, so it adds none; other turnouts' beds sit 3 cm lower than the
    // through bed so the two surfaces never fight where they overlap
    const onSharedBed = piece.sw && route.double && Math.abs(Math.abs(piece.sw.from) - route.halfSpacing) < 0.01 && Math.abs(Math.abs(piece.sw.to) - route.halfSpacing) < 0.01;
    if (!openDeck && !onSharedBed) {
      const prof = piece.kind === 'ramp' ? BALLAST_PROFILE.map(([a, b]) => [a, b - 0.03] as [number, number]) : BALLAST_PROFILE;
      ballast.extrude(frames, ss, prof, ox, oz, 0.5, 0.5);
    }
    for (const side of [-1, 1]) {
      rails.extrude(frames, ss, RAIL_PROFILE.map(([a, b]) => [a + side * RAIL_C, b + RAIL_BASE] as [number, number]), ox, oz, 1, 0.1, true);
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

  // sleepers: one row every 0.65 m across all the tracks at that point. Where
  // tracks overlap (turnouts, crossovers) their sleepers merge into one long
  // timber, square to the main line, so there is never a second set on top
  const pieces = piecesIn(railway, s0, s1), half = SLEEPER_LEN / 2, scale = new THREE.Vector3(1, 1, 1);
  for (let s = Math.ceil(s0 / SLEEPER_SPACING) * SLEEPER_SPACING; s < s1; s += SLEEPER_SPACING) {
    const spans: [number, number][] = [];
    for (const pc of pieces) if (s >= pc.s0 && s < pc.s1) { const o = pc.offset(s); spans.push([o - half, o + half]); }
    if (!spans.length) continue;
    spans.sort((a, b) => a[0] - b[0]);
    const merged = [spans[0]];
    for (const sp of spans.slice(1)) {
      const m = merged[merged.length - 1];
      if (sp[0] <= m[1] + 0.05) m[1] = Math.max(m[1], sp[1]); else merged.push(sp);
    }
    const st = route.structureAt(s / 1000);
    const open = st?.type === 'bridge' && st.style !== 'arch-viaduct';
    for (const [a, b] of merged) {
      route.alignment.sampleOffset(s, (a + b) / 2, f);
      e.set(f.cant, -f.heading, 0, 'YXZ');
      q.setFromEuler(e);
      p.set(f.x - ox, f.y + RAIL_BASE - 0.1, f.z - oz);
      sleeperMats.push(new THREE.Matrix4().compose(p, q, scale.set(1, 1, (b - a) / SLEEPER_LEN)));
      sleeperCols.push(open ? wood : conc);
    }
  }

  if (route.double) {
    // between the lines, except on open-deck bridges
    let a = s0;
    for (let s = s0; s <= s1; s += 5) {
      const st = route.structureAt(Math.min(s, s1) / 1000);
      const open = st?.type === 'bridge' && st.style !== 'arch-viaduct';
      if (open || s + 5 > s1) {
        const b = open ? s : s1;
        if (b - a > 1) infill(route, a, b, route.halfSpacing, ox, oz, ballast);
        a = s + 5;
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
  // rails are plain metal: position + normal only, so the parts merge
  for (const g of parts) for (const a of ['uv', 'color']) if (g.attributes[a]) g.deleteAttribute(a);
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

interface TurnoutEnd { toeKm: number; through: number; other: number; dir: 1 | -1 }

/** Where the turnout's inner rail crosses the through line's rail: km of the frog point. */
function frogKm(d: SwitchDef, end: TurnoutEnd) {
  const need = (2 * RAIL_C) / Math.abs(end.other - end.through); // fraction of the lateral move at the crossing
  const t = end.dir > 0 ? need : 1 - need;
  // invert smoothstep by bisection
  let lo = 0, hi = 1;
  for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (m * m * (3 - 2 * m) < t) lo = m; else hi = m; }
  return d.rampStart + (d.rampEnd - d.rampStart) * (lo + hi) / 2;
}

let turnoutMats: { blade: THREE.Material; frog: THREE.Material; check: THREE.Material; post: THREE.Material } | null = null;

/**
 * One set of points: switch blades at each toe (a crossover has two), which
 * slide across with the point machine, a cast crossing (frog) where the
 * diverging rail crosses the through rail, check rails opposite it, and the
 * point indicator. The sleepers under it are the merged long timbers of the
 * track chunk.
 */
export class SwitchView {
  readonly group = new THREE.Group();
  private blades: { mesh: THREE.Mesh; base: number; sign: number }[] = [];
  private lamp: THREE.Mesh;
  private lampMat: THREE.MeshBasicMaterial;

  constructor(route: Route, readonly sw: Switch) {
    const d = sw.def;
    turnoutMats ??= {
      blade: new THREE.MeshStandardMaterial({ color: 0x9a948e, metalness: 0.75, roughness: 0.35 }),
      frog: new THREE.MeshStandardMaterial({ color: 0x55504b, metalness: 0.6, roughness: 0.5 }),
      check: new THREE.MeshStandardMaterial({ color: 0x7d7873, metalness: 0.7, roughness: 0.42 }),
      post: new THREE.MeshStandardMaterial({ color: 0x333333 }),
    };
    const M = turnoutMats;
    const ends: TurnoutEnd[] = d.kind === 'crossover'
      ? [{ toeKm: d.rampStart, through: d.from, other: d.to, dir: 1 }, { toeKm: d.rampEnd, through: d.to, other: d.from, dir: -1 }]
      : d.kind === 'trailing' ? [{ toeKm: d.rampEnd, through: d.to, other: d.from, dir: -1 }] : [{ toeKm: d.rampStart, through: d.from, other: d.to, dir: 1 }];
    const f = newFrame();
    const bladeGeo = new THREE.BoxGeometry(9, 0.15, 0.06);
    const frogGeo = new THREE.BoxGeometry(2.6, 0.04, 0.18);
    const checkGeo = new THREE.BoxGeometry(4.2, 0.13, 0.05);
    const place = (geo: THREE.BufferGeometry, mat: THREE.Material, km: number, lat: number, up: number) => {
      route.alignment.sampleOffset(km * 1000, lat, f);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(f.x, f.y + RAIL_BASE + up, f.z);
      m.rotation.set(0, -f.heading, 0);
      m.castShadow = true;
      this.group.add(m);
      return m;
    };
    for (const end of ends) {
      const sign = Math.sign(end.other - end.through) || 1;
      // blades: in a frame at the toe, pointing away from it
      const toe = new THREE.Group();
      route.alignment.sampleOffset(end.toeKm * 1000, end.through, f);
      toe.position.set(f.x, f.y + RAIL_BASE, f.z);
      toe.rotation.set(0, -f.heading, 0);
      for (const side of [-1, 1]) {
        const b = new THREE.Mesh(bladeGeo, M.blade);
        b.position.set(end.dir * 4.5, 0.08, side * (RAIL_C - 0.06));
        b.castShadow = true;
        toe.add(b);
        this.blades.push({ mesh: b, base: side * (RAIL_C - 0.06), sign });
      }
      this.group.add(toe);
      // frog (top 7 mm under the rail head) where the rails cross; check rails opposite it,
      // inside the through line's far rail and inside the turnout's far rail
      const fk = frogKm(d, end);
      const o = end.through + sign * 2 * RAIL_C;
      place(frogGeo, M.frog, fk + end.dir * 0.0008, end.through + sign * RAIL_C, 0.145);
      place(checkGeo, M.check, fk, end.through - sign * (RAIL_C - 0.07), 0.095);
      place(checkGeo, M.check, fk, o + sign * (RAIL_C - 0.07), 0.095);
    }
    // point indicator on a short post beside the first toe
    const e0 = ends[0], side0 = Math.sign(e0.other - e0.through) || 1;
    place(new THREE.CylinderGeometry(0.04, 0.04, 1.1, 6), M.post, e0.toeKm - e0.dir * 0.0015, e0.through - side0 * 2.4, 0.55);
    this.lampMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.lamp = place(new THREE.CircleGeometry(0.16, 12), this.lampMat, e0.toeKm - e0.dir * 0.00155, e0.through - side0 * 2.4, 1.15);
    this.lamp.rotation.y += e0.dir > 0 ? -Math.PI / 2 : Math.PI / 2;
    this.lamp.castShadow = false;
  }

  update() {
    const t = this.sw.throw; // 0 normal .. 1 reverse
    for (const b of this.blades) b.mesh.position.z = b.base + (t - 0.5) * 0.12 * b.sign;
    this.lampMat.color.set(this.sw.moving ? 0x555555 : t > 0.5 ? 0xffc400 : 0xf2f2f2);
  }
}

export { RAMP_M };
