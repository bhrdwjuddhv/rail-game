import * as THREE from 'three/webgpu';
import { GeoBatch, mat } from '../core/GeoBatch';
import { labelTexture } from '../core/Textures';
import { labelMaterial, materials } from '../core/Materials';
import { newFrame, TrackFrame } from '@rail/shared/track/Chainage';
import { Strip } from '../track/TrackMeshBuilder';
import type { BoardDef, Route } from '@rail/shared/track/Route';
import type { Railway } from '@rail/shared/track/Railway';
import type { TerrainField } from '../world/TerrainField';
import { buildOHE, wireMaterial } from './OHE';
import { PLATFORM_H } from './Station';

const BOARD_STYLE: Record<BoardDef['kind'], { bg: string; fg: string; w: number; h: number; post: number; border?: string }> = {
  km: { bg: '#f4f4f0', fg: '#111', w: 0.45, h: 0.45, post: 1.0 },
  whistle: { bg: '#f5d000', fg: '#111', w: 0.9, h: 0.6, post: 1.6, border: '#111' },
  speed: { bg: '#ffffff', fg: '#111', w: 0.9, h: 0.9, post: 1.8, border: '#d00000' },
  caution: { bg: '#f5d000', fg: '#111', w: 0.9, h: 0.9, post: 1.8, border: '#111' },
  termination: { bg: '#f5d000', fg: '#111', w: 0.7, h: 0.7, post: 1.8, border: '#111' },
  gradient: { bg: '#ffffff', fg: '#111', w: 0.9, h: 0.45, post: 1.0 },
  approach: { bg: '#ffffff', fg: '#111', w: 1.2, h: 0.6, post: 1.6, border: '#111' },
  stop: { bg: '#ffffff', fg: '#111', w: 0.45, h: 0.6, post: 1.4, border: '#c00' },
  ghat: { bg: '#f5d000', fg: '#111', w: 2.2, h: 0.7, post: 1.6, border: '#111' },
};

/** A board on a post facing approaching trains (which travel toward +km in `route`'s view). */
export function boardMesh(route: Route, b: BoardDef, batch: GeoBatch, ox: number, oz: number, group: THREE.Group, baseY?: number) {
  const st = BOARD_STYLE[b.kind];
  const f = newFrame();
  route.alignment.sampleOffset(b.km * 1000, b.offset, f);
  // posts go 15 cm into the ground (ground = formation - 5 cm beside the track)
  const y0 = baseY ?? f.y - 0.15;
  batch.box(0.08, st.post + st.h, 0.08, mat(f.x - ox, y0 + (st.post + st.h) / 2, f.z - oz), '#333');
  const t = labelTexture(b.text, { bg: st.bg, fg: st.fg, w: Math.round(256 * st.w / st.h), h: 256, border: st.border });
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(st.w, st.h), labelMaterial(t));
  plate.position.set(f.x - ox, y0 + st.post + st.h / 2, f.z - oz);
  plate.rotation.y = -f.heading - Math.PI / 2; // face -km direction
  plate.position.x -= Math.cos(f.heading) * 0.05;
  plate.position.z -= Math.sin(f.heading) * 0.05;
  group.add(plate);
}

let poleGeo: THREE.BufferGeometry | null = null;
function telegraphPole() {
  if (poleGeo) return poleGeo;
  const b = new GeoBatch();
  b.cyl(0.08, 0.11, 7.5, 6, mat(0, 3.75, 0), '#6b5a48');
  b.box(0.1, 0.1, 1.4, mat(0, 7.1, 0), '#5a4a3a');
  for (const z of [-0.55, 0.55]) b.cyl(0.05, 0.05, 0.12, 6, mat(0, 7.22, z), '#e8e8e8');
  poleGeo = b.geometry('std')!;
  return poleGeo;
}

/**
 * Everything beside the track in one chunk [s0, s1) (surveyed metres): OHE,
 * both directions' boards, telegraph poles, relay huts, gangmen huts with
 * stacked sleepers, cable trench, cutting drains and fencing. On a double
 * line everything lateral moves out by half the track spacing.
 */
export function buildLinesideChunk(railway: Railway, field: TerrainField, s0: number, s1: number, ox: number, oz: number): THREE.Group {
  const route = railway.main;
  const H = route.halfSpacing;
  const out = (lat: number) => lat + Math.sign(lat) * H;
  const group = new THREE.Group();
  const batch = new GeoBatch();
  const lines: number[] = [];
  buildOHE(railway, s0, s1, ox, oz, batch, lines);

  // each direction's boards, built in its own view so they face its trains
  const inChunk = (v: Route, km: number) => { const c = v.canonicalKm(km) * 1000; return c >= s0 && c < s1; };
  for (const v of railway.views) {
    for (const b of v.boards) {
      if (!inChunk(v, b.km)) continue;
      let baseY: number | undefined;
      if (b.kind === 'stop') baseY = v.alignment.elevationAt(b.km) + PLATFORM_H;
      boardMesh(v, b, batch, ox, oz, group, baseY);
    }
  }

  const f = newFrame();
  const at = (s: number, lat: number) => { route.alignment.sampleOffset(s, lat, f); return f; };
  /**
   * A small building beside the line: on the highest ground under its corners
   * with a plinth down to the lowest, so it never sinks into or floats over a slope.
   */
  const seat = (p: { x: number; z: number; heading: number }, w: number, d: number) => {
    const cs = Math.cos(p.heading), sn = Math.sin(p.heading);
    let lo = Infinity, hi = -Infinity;
    for (const [u, v] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const a = (u * w) / 2, b = (v * d) / 2;
      const h = field.height(p.x + a * cs - b * sn, p.z + a * sn + b * cs);
      lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
    const depth = hi - lo + 0.3;
    batch.box(w + 0.3, depth + 0.15, d + 0.3, mat(p.x - ox, hi + 0.15 - (depth + 0.15) / 2, p.z - oz, -p.heading), '#9c968c', 'std');
    return hi + 0.15;
  };
  const clearOf = (s: number, m = 0.05) => {
    const km = s / 1000;
    return !route.structureAt(km) && !route.stationAt(km, m) && !route.data.levelCrossings.some(l => Math.abs(l.km - km) < 0.04);
  };

  // telegraph poles
  const poles: THREE.Matrix4[] = [];
  let prevTop: number[] | null = null;
  for (let s = Math.ceil(s0 / 50) * 50; s < s1; s += 50) {
    if (!clearOf(s, 0.3)) { prevTop = null; continue; }
    const p = at(s, out(11.5));
    const y = field.height(p.x, p.z);
    poles.push(mat(p.x - ox, y, p.z - oz, -p.heading));
    const top = [p.x - ox, y + 7.2, p.z - oz];
    if (prevTop) for (const dz of [-0.55, 0.55]) {
      const sx = -Math.sin(p.heading) * dz, sz = Math.cos(p.heading) * dz;
      lines.push(prevTop[0] + sx, prevTop[1], prevTop[2] + sz, top[0] + sx, top[1], top[2] + sz);
    }
    prevTop = top;
  }
  // merged into the chunk's std batch (no separate draw)
  for (const m of poles) batch.add(telegraphPole(), m, '#ffffff');

  // relay huts at automatic signals, outside each direction's line
  const vf = newFrame();
  for (const v of railway.views) for (const sg of v.signals) {
    if (sg.kind !== 'automatic' || !inChunk(v, sg.km + 0.015)) continue;
    const p = (v.alignment.sampleOffset(sg.km * 1000 + 15, sg.offset - 6.5, vf), vf);
    const y = seat(p, 2.6, 2.2);
    batch.box(2.6, 2.5, 2.2, mat(p.x - ox, y + 1.25, p.z - oz, -p.heading), '#d9d2bf', 'std');
    batch.box(2.9, 0.15, 2.5, mat(p.x - ox, y + 2.55, p.z - oz, -p.heading), '#8a8a85', 'std');
    batch.box(0.9, 1.9, 0.05, mat(p.x - ox, y + 0.95, p.z - oz, -p.heading, 0, 0, 1, 1, 1).multiply(mat(0, 0, -1.11)), '#3d5d7a', 'metal');
  }

  // gangmen hut + stacked released sleepers every ~4 km
  for (let s = Math.ceil(s0 / 4000) * 4000 + 1300; s < s1; s += 4000) {
    if (!clearOf(s, 0.4)) continue;
    const p = at(s, out(15));
    const y = seat(p, 4, 3.2);
    batch.box(4, 2.8, 3.2, mat(p.x - ox, y + 1.4, p.z - oz, -p.heading), '#e3d6b8', 'std');
    batch.box(4.6, 0.2, 3.8, mat(p.x - ox, y + 2.9, p.z - oz, -p.heading, 0, 0.12), '#7d3b2c');
    for (let k = 0; k < 4; k++) for (let n = 0; n < 6; n++) {
      const q = at(s + 9 + n * 0.3, out(9.5));
      batch.box(0.25, 0.2, 2.75, mat(q.x - ox, field.height(q.x, q.z) + 0.1 + k * 0.21, q.z - oz, -q.heading), k % 2 ? '#8f8a82' : '#6d5b47');
    }
  }

  // cable trough along the left cess and open drains in cuttings: continuous
  // strips that follow the line (curves, gradients) on the flat formation
  // (ground = formation - 5 cm there), so nothing lies off the cess or half
  // buried in a cutting slope
  const trough = new Strip(), drains = new Strip();
  const run = (pred: (s: number) => boolean, add: (frames: TrackFrame[], ss: number[]) => void) => {
    let frames: TrackFrame[] = [], ss: number[] = [];
    const flush = () => { if (frames.length > 1) add(frames, ss); frames = []; ss = []; };
    for (let s = Math.ceil(s0 / 5) * 5; s <= s1; s += 5) {
      if (!pred(s)) { flush(); continue; }
      route.alignment.sample(s, f);
      frames.push({ ...f, cant: 0 });
      ss.push(s);
    }
    flush();
  };
  const G = -0.05;
  // trough: 50 cm concrete channel with its lid 12 cm above the ground (counter-clockwise profile)
  const tl = out(-4.7);
  run(s => clearOf(s, 0.02), (fr, ss) => trough.extrude(fr, ss, [[tl + 0.25, G - 0.05], [tl + 0.25, G + 0.12], [tl - 0.25, G + 0.12], [tl - 0.25, G - 0.05]], ox, oz, 1, 1));
  // drains: open U channels at the foot of each cutting side
  for (const side of [-1, 1]) {
    const c = out(side * 6.1);
    // a real cutting (1.8 m+ of ground above the formation on this side over 20 m), not a dip in the fields
    const deep = (s: number) => { const n = at(s, out(side * 14)); return field.natural(n.x, n.z, null) >= n.y + 1.8; };
    const inCutting = (s: number) => clearOf(s, 0.02) && deep(s - 10) && deep(s) && deep(s + 10);
    const w = 0.35, wall = 0.08, lip = G + 0.1, floor = G + 0.01;
    run(inCutting, (fr, ss) => drains.extrude(fr, ss, [
      [c + w, G - 0.05], [c + w, lip], [c + w - wall, lip], [c + w - wall, floor], [c - w + wall, floor], [c - w + wall, lip], [c - w, lip], [c - w, G - 0.05],
    ], ox, oz, 1, 1));
  }
  const M = materials();
  for (const [st, colour] of [[trough, 0xc9c4ba], [drains, 0xb3afa6]] as const) {
    if (!st.pos.length) continue;
    const g = st.geometry();
    const col = g.getAttribute('color') as THREE.BufferAttribute;
    const c = new THREE.Color(colour);
    for (let i = 0; i < col.count; i++) col.setXYZ(i, c.r, c.g, c.b);
    const m = new THREE.Mesh(g, M.concrete);
    m.receiveShadow = true;
    group.add(m);
  }

  // fencing along towns and colonies
  const posts: THREE.Matrix4[] = [];
  for (const side of [-1, 1]) {
    let prev: number[][] | null = null;
    for (let s = Math.ceil(s0 / 4) * 4; s < s1; s += 4) {
      const zone = route.zoneAt(s / 1000).zone;
      if ((zone !== 'town' && zone !== 'colony') || !clearOf(s, 0.35)) { prev = null; continue; }
      const p = at(s, out(side * 16.5));
      const y = field.height(p.x, p.z);
      posts.push(mat(p.x - ox, y + 0.7, p.z - oz, -p.heading));
      const cur = [[p.x - ox, y + 0.6, p.z - oz], [p.x - ox, y + 1.2, p.z - oz]];
      if (prev) for (let k = 0; k < 2; k++) lines.push(...prev[k], ...cur[k]);
      prev = cur;
    }
  }
  const post = new THREE.BoxGeometry(0.1, 1.4, 0.1);
  for (const m of posts) batch.add(post, m, '#b9b3a8');

  if (!batch.isEmpty()) group.add(batch.build(materials() as unknown as Record<string, THREE.Material>));
  if (lines.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    g.computeBoundingSphere();
    group.add(new THREE.LineSegments(g, wireMaterial));
  }
  return group;
}
