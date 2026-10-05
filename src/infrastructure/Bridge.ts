import * as THREE from 'three/webgpu';
import { GeoBatch, mat } from '../core/GeoBatch';
import { materials } from '../core/Materials';
import { newFrame, RAIL_TOP } from '../track/Chainage';
import type { Route, StructureData } from '../track/Route';
import type { TerrainField } from '../world/TerrainField';

/** Build a bridge as merged geometry following the track. */
export function buildBridge(route: Route, field: TerrainField, b: StructureData): THREE.Group {
  const f = newFrame();
  const mid = (b.fromKm + b.toKm) / 2;
  route.alignment.sample(mid * 1000, f);
  const ox = f.x, oz = f.z;
  const group = new THREE.Group();
  group.position.set(ox, 0, oz);
  const batch = new GeoBatch();
  const s0 = b.fromKm * 1000, s1 = b.toKm * 1000;
  const at = (s: number, lat: number) => { route.alignment.sampleOffset(s, lat, f); return { x: f.x - ox, y: f.y, z: f.z - oz, ry: -f.heading, wx: f.x, wz: f.z }; };
  const ground = (p: { wx: number; wz: number }) => field.height(p.wx, p.wz);
  const railBase = RAIL_TOP - 0.172;

  // abutments at both ends
  for (const s of [s0, s1]) {
    const p = at(s, 0);
    const g = Math.min(ground(p), p.y - 2);
    const h = p.y - g + 3;
    batch.box(4, h, 9, mat(p.x, p.y - h / 2 + 0.1, p.z, p.ry), '#a39d92', b.style === 'arch-viaduct' ? 'stone' : 'concrete');
  }

  if (b.style === 'girder' || b.style === 'steel-truss') {
    const span = b.style === 'girder' ? 20 : 61;
    const n = Math.max(1, Math.round((s1 - s0) / span));
    const L = (s1 - s0) / n;
    for (let i = 0; i < n; i++) {
      const a = s0 + i * L, c = a + L, m = (a + c) / 2;
      const p = at(m, 0);
      const deck = p.y + railBase - 0.21; // bottom of sleepers
      if (b.style === 'girder') {
        for (const lat of [-0.9, 0.9]) {
          const q = at(m, lat);
          batch.box(L - 0.4, 1.8, 0.45, mat(q.x, deck - 0.9, q.z, q.ry), '#56606a', 'metal');
        }
        for (const lat of [-1.9, 1.9]) {
          const q = at(m, lat);
          batch.box(L, 0.1, 0.8, mat(q.x, deck + 0.05, q.z, q.ry), '#6d6a65', 'metal'); // walkway
          const r = at(m, lat * 1.08);
          batch.box(L, 0.06, 0.06, mat(r.x, deck + 1.05, r.z, r.ry), '#5d6670', 'metal');
          for (let k = -L / 2; k <= L / 2; k += 2.5) { const pp = at(m + k, lat * 1.08); batch.box(0.06, 1.0, 0.06, mat(pp.x, deck + 0.55, pp.z, pp.ry), '#5d6670', 'metal'); }
        }
      } else {
        // through truss: chords, verticals, diagonals, portal and top bracing
        const H = 9, panel = L / 8;
        for (const lat of [-3.4, 3.4]) {
          const q = at(m, lat);
          batch.box(L, 0.7, 0.6, mat(q.x, deck - 0.2, q.z, q.ry), '#4f5b63', 'metal');
          batch.box(L - panel * 2, 0.6, 0.6, mat(q.x, deck + H, q.z, q.ry), '#4f5b63', 'metal');
          for (let k = 0; k <= 8; k++) {
            const s = a + k * panel;
            const v = at(s, lat);
            if (k > 0 && k < 8) batch.box(0.35, H, 0.4, mat(v.x, deck + H / 2, v.z, v.ry), '#56636b', 'metal');
            if (k < 8) {
              // diagonal from bottom at k to top at k+1 (or reversed in the second half)
              const up = k < 4;
              const sA = s, sB = s + panel;
              const pA = at(sA, lat), pB = at(sB, lat);
              const yA = deck + (up ? 0 : H), yB = deck + (up ? H : 0);
              const dx = pB.x - pA.x, dz = pB.z - pA.z, dy = yB - yA;
              const len = Math.hypot(dx, dy, dz);
              const o = new THREE.Object3D();
              o.position.set((pA.x + pB.x) / 2, (yA + yB) / 2, (pA.z + pB.z) / 2);
              o.lookAt(pB.x, yB, pB.z);
              o.updateMatrix();
              const isEnd = k === 0 || k === 7;
              batch.add(new THREE.BoxGeometry(0.4, 0.4, len), o.matrix, isEnd ? '#4a565e' : '#5a6870', 'metal');
            }
          }
        }
        for (let k = 1; k < 8; k++) {
          const v = at(a + k * panel, 0);
          batch.box(0.35, 0.35, 6.8, mat(v.x, deck + H, v.z, v.ry), '#56636b', 'metal');
          batch.box(0.4, 0.6, 6.8, mat(v.x, deck - 0.5, v.z, v.ry), '#4f5b63', 'metal');
        }
        for (const lat of [-0.9, 0.9]) { const q = at(m, lat); batch.box(L, 0.9, 0.3, mat(q.x, deck - 0.45, q.z, q.ry), '#4f5b63', 'metal'); }
      }
      // pier at the end of each span (except the last, which is an abutment)
      if (i < n - 1) {
        const q = at(c, 0);
        const g = ground(q);
        const h = deck - g + 1;
        if (b.style === 'steel-truss') {
          batch.cyl(2.6, 3, h, 16, mat(q.x, g + h / 2 - 1, q.z), '#9e978a', 'concrete');
          batch.box(3.5, 1.2, 8.5, mat(q.x, deck - 1.1, q.z, q.ry), '#a8a195', 'concrete');
        } else {
          batch.box(2.4, h, 6.5, mat(q.x, g + h / 2 - 1, q.z, q.ry), '#a8a195', 'concrete');
        }
      }
    }
  } else {
    // stone arch viaduct
    const span = 15;
    const n = Math.max(1, Math.round((s1 - s0) / span));
    const L = (s1 - s0) / n;
    const pierW = 2.6;
    for (let i = 0; i < n; i++) {
      const a = s0 + i * L, c = a + L, m = (a + c) / 2;
      const p = at(m, 0);
      const deckTop = p.y - 0.05;
      // spandrel/deck block above the arch crown
      batch.box(L, 2.2, 7.4, mat(p.x, deckTop - 1.1, p.z, p.ry), '#8e877b', 'stone');
      // arch ring as a half-cylinder shell (open underneath)
      const ring = new THREE.CylinderGeometry((L - pierW) / 2, (L - pierW) / 2, 7.4, 16, 1, true, 0, Math.PI);
      batch.add(ring, mat(p.x, deckTop - 2.2, p.z, p.ry + Math.PI / 2, Math.PI / 2, 0, 1, 1, 1), '#7f786c', 'stone');
      // spandrel walls filling between arch and deck at the haunches
      for (const side of [-1, 1]) {
        const q = at(m + side * (L / 2 - 2.2), 0);
        batch.box(4.4 - pierW / 2, (L - pierW) / 4 + 0.5, 7.4, mat(q.x, deckTop - 2.2 - (L - pierW) / 8, q.z, q.ry), '#8a8377', 'stone');
      }
      for (const lat of [-3.6, 3.6]) { const q = at(m, lat); batch.box(L, 0.9, 0.4, mat(q.x, deckTop + 0.45, q.z, q.ry), '#9a9386', 'stone'); }
      if (i < n - 1) {
        const q = at(c, 0);
        const g = ground(q);
        const h = deckTop - 2.2 - g + 2;
        batch.box(pierW, h, 7.8, mat(q.x, g + h / 2 - 2, q.z, q.ry), '#857e72', 'stone');
        batch.box(pierW + 1, 0.6, 8.4, mat(q.x, deckTop - 2.2, q.z, q.ry), '#9a9386', 'stone');
      }
    }
  }
  group.add(batch.build(materials() as unknown as Record<string, THREE.Material>));
  return group;
}
