import * as THREE from 'three/webgpu';
import { GeoBatch, mat } from '../core/GeoBatch';
import { newFrame, RAIL_TOP } from '@rail/shared/track/Chainage';
import type { Route } from '@rail/shared/track/Route';
import type { Railway } from '@rail/shared/track/Railway';

/** contact wire height above rail top (m): set per route (high-rise OHE on freight corridors) */
export let CONTACT_H = 5.55;
export function setContactHeight(h: number) { CONTACT_H = h; }
const SYSTEM_H = 1.4;

const mastCache = new WeakMap<Route, number[]>();

/** Mast positions (m) along the route; spans shorten on curves to limit wire offset. */
export function mastPositions(route: Route): number[] {
  let m = mastCache.get(route);
  if (m) return m;
  m = [];
  const a = route.alignment;
  for (let s = 20; s < a.length; ) {
    m.push(s);
    const R = a.radiusAt(s / 1000);
    s += Math.max(27, Math.min(63, Math.sqrt(8 * R * 0.22)));
  }
  mastCache.set(route, m);
  return m;
}

/** Track offsets electrified at chainage s (every line of both directions). */
export function wiredOffsets(railway: Railway, s: number) {
  const km = s / 1000;
  const o: number[] = [];
  for (const l of railway.layout.lines) if (km >= l.fromKm && km <= l.toKm && !o.includes(l.offset)) o.push(l.offset);
  return o.sort((a, b) => a - b);
}

export const wireMaterial = new THREE.LineBasicMaterial({ color: 0x2a2420 });

/** galvanised steel, plain diffuse (the vertex-colour metal material renders near-black without an environment map) */
const GALV = '#8f979b';
const MAST_H = 8.2;

let mastGeo: THREE.BufferGeometry | null = null;
/** I-section mast (flanges face the track), base plate; origin at the base, local x along the track. */
function iMast() {
  if (mastGeo) return mastGeo;
  const b = new GeoBatch();
  // broad-flange section, 300 x 280 mm
  for (const z of [-0.13, 0.13]) b.box(0.3, MAST_H, 0.03, mat(0, MAST_H / 2, z), GALV);
  b.box(0.025, MAST_H, 0.26, mat(0, MAST_H / 2, 0), GALV);
  b.box(0.5, 0.03, 0.5, mat(0, 0.015, 0), GALV);
  return (mastGeo = b.geometry('std')!);
}

const latticeGeo = new Map<number, THREE.BufferGeometry>();
/** Lattice upright for portals: four corner angles with zig-zag bracing on each face (cached per 0.5 m of height). */
function latticeMast(h: number) {
  h = Math.round(h * 2) / 2;
  const hit = latticeGeo.get(h);
  if (hit) return hit;
  const b = new GeoBatch(), w = 0.36, bay = 0.9;
  for (const [x, z] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) b.box(0.05, h, 0.05, mat(x * w / 2, h / 2, z * w / 2), GALV);
  const diag = Math.hypot(w, bay), ang = Math.atan2(bay, w);
  for (let y = 0, k = 0; y + bay <= h; y += bay, k++) {
    const sgn = k % 2 ? 1 : -1;
    for (const z of [-w / 2, w / 2]) b.box(diag, 0.03, 0.02, mat(0, y + bay / 2, z, 0, 0, sgn * ang), GALV);
    for (const x of [-w / 2, w / 2]) b.box(0.02, 0.03, diag, mat(x, y + bay / 2, 0, 0, sgn * -ang), GALV);
  }
  b.box(0.6, 0.03, 0.6, mat(0, 0.015, 0), GALV);
  const g = b.geometry('std')!;
  latticeGeo.set(h, g);
  return g;
}

/** OHE for chunk [s0,s1): masts, cantilevers/portals into `batch`, wires into `lines`. */
export function buildOHE(railway: Railway, s0: number, s1: number, ox: number, oz: number, batch: GeoBatch, lines: number[]) {
  const route = railway.main;
  const masts = mastPositions(route);
  const f = newFrame(), g = newFrame();
  for (let i = 0; i < masts.length; i++) {
    const s = masts[i];
    if (s < s0 || s >= s1) continue;
    const km = s / 1000;
    const tunnel = route.inTunnel(km);
    route.alignment.sample(s, f);
    const rail = f.y + RAIL_TOP;
    const offs = wiredOffsets(railway, s);
    const minO = Math.min(...offs), maxO = Math.max(...offs);
    // portals over loops, along platforms (no room for masts between the faces) and on bridges
    const st = route.stations.find(x => km >= x.platformFromKm - 0.02 && km <= x.platformToKm + 0.02);
    const onBridge = route.structureAt(km)?.type === 'bridge';
    const portal = offs.length > 2 || ((!!st || onBridge) && offs.length > 1);
    let lo = minO - 3.3, hi = maxO + 3.3;
    if (st) for (const p of st.platforms) for (const e of [p.from, p.to]) { if (e < 0) lo = Math.min(lo, e - 0.8); else hi = Math.max(hi, e + 0.8); }
    const at = (lat: number, y: number) => ({ x: f.x - Math.sin(f.heading) * lat - ox, y, z: f.z + Math.cos(f.heading) * lat - oz });
    const ry = -f.heading;
    if (!tunnel) {
      if (portal) {
        // portal spanning all tracks
        // lattice uprights on concrete foundations (set into the ground, 30 cm showing), a boom across all tracks
        const foot = f.y - 0.05 + 0.3;
        for (const lat of [lo, hi]) {
          const p = at(lat, rail);
          batch.box(0.9, 0.9, 0.9, mat(p.x, foot - 0.45, p.z, ry), '#a9a59c', 'concrete');
          batch.add(latticeMast(rail + CONTACT_H + 2.45 - foot), mat(p.x, foot, p.z, ry), '#ffffff');
        }
        const c = at((lo + hi) / 2, rail);
        batch.box(0.3, 0.5, hi - lo + 0.3, mat(c.x, rail + CONTACT_H + 2.2, c.z, ry), GALV);
        for (const o of offs) { const p = at(o, rail); batch.box(0.08, 0.6, 0.08, mat(p.x, rail + CONTACT_H + 1.65, p.z, ry), GALV); }
      } else {
        // a mast outside each outer track, its cantilever reaching over that track
        // (single line: one mast on the left; double line: one each side)
        const sides = offs.length > 1 ? [-1, 1] : [-1];
        for (const side of sides) {
          const track = side < 0 ? minO : maxO;
          const lat = track + side * 3.3;
          const p = at(lat, rail);
          // concrete foundation set into the ground (ground = formation - 5 cm), 25 cm showing; vertical I-section mast on it
          const foot = f.y - 0.05 + 0.25;
          batch.box(0.7, 0.8, 0.7, mat(p.x, foot - 0.4, p.z, ry), '#a9a59c', 'concrete');
          batch.add(iMast(), mat(p.x, foot, p.z, ry, 0, 0, 1, (rail + CONTACT_H + SYSTEM_H + 0.5 - foot) / MAST_H, 1), '#ffffff');
          // cantilever: top tube + bracket + registration arm
          const mid = at(track + side * 1.65, rail);
          batch.box(0.07, 0.07, 3.6, mat(mid.x, rail + CONTACT_H + SYSTEM_H, mid.z, ry), GALV);
          batch.box(0.07, 0.07, 3.7, mat(mid.x, rail + CONTACT_H + 0.65, mid.z, ry, 0.2 * -side), GALV);
          const ins = at(lat - side * 0.4, rail);
          batch.cyl(0.08, 0.08, 0.5, 8, mat(ins.x, rail + CONTACT_H + SYSTEM_H, ins.z, ry, Math.PI / 2), '#6b4d3a');
        }
      }
    }
    // wires to the next mast
    const s2 = masts[i + 1];
    if (s2 === undefined) continue;
    route.alignment.sample(s2, g);
    const rail2 = g.y + RAIL_TOP;
    const stag = (i % 2 ? 0.2 : -0.2), stag2 = -stag;
    for (const o of offs) {
      if (!wiredOffsets(railway, s2).includes(o)) continue;
      const a1 = at(o + stag, rail + CONTACT_H);
      const pB = { x: g.x - Math.sin(g.heading) * (o + stag2) - ox, y: rail2 + CONTACT_H, z: g.z + Math.cos(g.heading) * (o + stag2) - oz };
      lines.push(a1.x, a1.y, a1.z, pB.x, pB.y, pB.z);
      // catenary with parabolic sag, droppers every ~9 m
      const N = 8;
      let prev: number[] | null = null;
      for (let k = 0; k <= N; k++) {
        const t = k / N;
        const x = a1.x + (pB.x - a1.x) * t, z = a1.z + (pB.z - a1.z) * t;
        const yContact = a1.y + (pB.y - a1.y) * t;
        const y = yContact + SYSTEM_H - 4 * t * (1 - t) * (SYSTEM_H - 0.25);
        if (prev) lines.push(prev[0], prev[1], prev[2], x, y, z);
        if (k > 0 && k < N) lines.push(x, y, z, x, yContact, z);
        prev = [x, y, z];
      }
    }
  }
}
