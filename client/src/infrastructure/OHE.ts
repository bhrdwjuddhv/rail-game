import * as THREE from 'three/webgpu';
import { GeoBatch, mat } from '../core/GeoBatch';
import { newFrame, RAIL_TOP } from '@rail/shared/track/Chainage';
import type { Route } from '@rail/shared/track/Route';

export const CONTACT_H = 5.55; // contact wire above rail top
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

/** Track offsets electrified at chainage s. */
export function wiredOffsets(route: Route, s: number) {
  const km = s / 1000;
  const o = [0];
  for (const l of route.graph.lines) if (l.id !== 'main' && km >= l.fromKm && km <= l.toKm) o.push(l.offset);
  return o;
}

export const wireMaterial = new THREE.LineBasicMaterial({ color: 0x1d1d1d });

/** OHE for chunk [s0,s1): masts, cantilevers/portals into `batch`, wires into `lines`. */
export function buildOHE(route: Route, s0: number, s1: number, ox: number, oz: number, batch: GeoBatch, lines: number[]) {
  const masts = mastPositions(route);
  const f = newFrame(), g = newFrame();
  for (let i = 0; i < masts.length; i++) {
    const s = masts[i];
    if (s < s0 || s >= s1) continue;
    const km = s / 1000;
    const tunnel = route.inTunnel(km);
    route.alignment.sample(s, f);
    const rail = f.y + RAIL_TOP;
    const offs = wiredOffsets(route, s);
    const minO = Math.min(...offs), maxO = Math.max(...offs);
    const at = (lat: number, y: number) => ({ x: f.x - Math.sin(f.heading) * lat - ox, y, z: f.z + Math.cos(f.heading) * lat - oz });
    const ry = -f.heading;
    if (!tunnel) {
      if (offs.length > 1) {
        // portal spanning all tracks
        for (const lat of [minO - 3.3, maxO + 3.3]) { const p = at(lat, rail); batch.box(0.35, 8.4, 0.35, mat(p.x, rail + 4.2 - 0.6, p.z, ry), '#7b8086', 'metal'); }
        const c = at((minO + maxO) / 2, rail);
        batch.box(0.3, 0.5, maxO - minO + 6.9, mat(c.x, rail + 7.7, c.z, ry), '#7b8086', 'metal');
        for (const o of offs) { const p = at(o, rail); batch.box(0.08, 0.6, 0.08, mat(p.x, rail + 7.2, p.z, ry), '#555', 'metal'); }
      } else {
        const side = -1;
        const lat = side * 3.3;
        const p = at(lat, rail);
        batch.box(0.32, 8.2, 0.32, mat(p.x, rail + 4.1 - 0.6, p.z, ry), '#7b8086', 'metal');
        batch.box(0.6, 0.4, 0.6, mat(p.x, rail - 0.6, p.z, ry), '#9a968e'); // foundation
        // cantilever: top tube + bracket + registration arm
        const mid = at(lat / 2, rail);
        batch.box(0.07, 0.07, 3.6, mat(mid.x, rail + CONTACT_H + SYSTEM_H, mid.z, ry), '#8c8f93', 'metal');
        batch.box(0.07, 0.07, 3.7, mat(mid.x, rail + CONTACT_H + 0.65, mid.z, ry, 0.2), '#8c8f93', 'metal');
        const ins = at(lat + 0.4, rail);
        batch.cyl(0.08, 0.08, 0.5, 8, mat(ins.x, rail + CONTACT_H + SYSTEM_H, ins.z, ry, Math.PI / 2), '#6b4d3a');
      }
    }
    // wires to the next mast
    const s2 = masts[i + 1];
    if (s2 === undefined) continue;
    route.alignment.sample(s2, g);
    const rail2 = g.y + RAIL_TOP;
    const stag = (i % 2 ? 0.2 : -0.2), stag2 = -stag;
    for (const o of offs) {
      if (!wiredOffsets(route, s2).includes(o)) continue;
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
