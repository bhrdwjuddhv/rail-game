import * as THREE from 'three/webgpu';
import { GeoBatch, mat } from '../core/GeoBatch';
import { materials } from '../core/Materials';
import { newFrame, RAIL_TOP } from '@rail/shared/track/Chainage';
import { rng } from '@rail/shared/util';
import type { Route, StructureData, YardDef } from '@rail/shared/track/Route';
import type { TerrainField } from '../world/TerrainField';
import { looseContainer } from '../train/Wagons';
import { COACHES } from '../data';
import { CONTACT_H } from './OHE';

/**
 * Freight corridor structures (original designs):
 *   road over-bridge   reinforced-earth ramps and a concrete span high over the
 *                      high-rise wires (corridors have no level crossings)
 *   container depot    stacks of containers in blocks, rubber-tyred gantry
 *                      cranes, high-mast lights, parked trucks
 *   port               the same yard on a quay, with ship-to-shore cranes, a
 *                      container ship alongside and a lighthouse offshore
 *   hill fort          sandstone walls and bastions on the highest ground near
 *                      the line, with a palace and a temple inside
 */

const M = () => materials() as unknown as Record<string, THREE.Material>;
const TINTS = COACHES['container-ds']?.tints ?? ['#b5442f', '#2f5d8a', '#3f7d4a', '#c9a227', '#d9d9d9'];
const SANDSTONE = '#c8955c';

// ---------------------------------------------------------------- road over-bridge

export function buildRob(route: Route, field: TerrainField, s: StructureData): THREE.Group {
  const f = newFrame();
  const km = (s.fromKm + s.toKm) / 2;
  route.alignment.sample(km * 1000, f);
  const ox = f.x, oz = f.z;
  // the road crosses square to the line; t = distance along the road (+ = Up side)
  const dx = -Math.sin(f.heading), dz = Math.cos(f.heading);
  const ry = -Math.atan2(dz, dx);
  const top = f.y + RAIL_TOP + CONTACT_H + 2.6;
  const SPAN = 17, GRADE = 1 / 25, W = 11, STEP = 8;
  const highway = route.zoneAt(km).roadOffset;
  const b = new GeoBatch();
  const ground = (t: number) => field.height(ox + dx * t, oz + dz * t);
  /** frame at t along the road, height y, tilted by rz along the road */
  const at = (t: number, y: number, rz = 0) => mat(dx * t, y, dz * t, ry, 0, rz);
  const off = (m: THREE.Matrix4, y: number, z: number) => m.clone().multiply(mat(0, y, z));
  const deckParts = (m: THREE.Matrix4, len: number) => {
    b.box(len, 0.35, W, off(m, -0.17, 0), '#3a3c3f');
    for (const e of [-1, 1]) {
      b.box(len, 0.95, 0.35, off(m, 0.45, e * (W / 2 - 0.17)), '#c9c3b8', 'concrete');   // crash barrier
      b.box(len, 0.18, 0.12, off(m, 0.01, e * (W / 2 - 1.6)), '#d8d4c4');                // kerb line
    }
  };

  // main span over the line on two box girders, with pier caps and columns each side
  const m0 = at(0, top);
  deckParts(m0, 2 * SPAN + 2);
  b.box(2 * SPAN + 2, 1.6, W - 1.2, off(m0, -1.15, 0), '#b8b1a5', 'concrete');
  for (const e of [-1, 1]) {
    const t = e * SPAN, g = ground(t);
    b.box(1.6, 1.1, W, at(t, top - 2.4), '#aaa397', 'concrete');
    for (const z of [-3, 3]) b.cyl(0.6, 0.6, top - 2.9 - g + 1, 12, off(at(t, (top - 2.9 + g - 1) / 2), 0, z), '#aaa397', 'concrete');
  }
  for (const t of [-12, 0, 12]) for (const z of [-1, 1]) {
    const q = off(at(t, top), 0, z * (W / 2 - 0.4));
    b.cyl(0.08, 0.1, 8, 6, off(q, 4.4, 0), '#5d6670', 'metal');
    b.box(1.2, 0.15, 0.4, off(q, 8.4, -z * 0.5), '#fff3c4', 'lamp');
  }

  // ramps down to the ground at 1 in 25: reinforced earth between panel walls,
  // carried on piers where they pass over the highway beside the line
  for (const e of [-1, 1]) {
    for (let t = SPAN + 1; t < 450; t += STEP) {
      const tm = e * (t + STEP / 2), y = top - (t + STEP / 2 - SPAN) * GRADE, g = ground(tm);
      if (y - g < 0.3) break;
      const rz = -e * Math.atan(GRADE);
      deckParts(at(tm, y, rz), STEP + 0.1);
      const overRoad = highway !== undefined && Math.abs(tm - highway) < 12;
      if (overRoad) {
        b.box(STEP + 0.1, 1.2, W - 1.2, off(at(tm, y, rz), -1.0, 0), '#b8b1a5', 'concrete');
      } else {
        const h = y - 0.35 - g + 1.5;
        b.box(STEP + 0.05, h, W, at(tm, g - 1.5 + h / 2), '#b9ad98', 'concrete');
      }
      if (overRoad && Math.abs(tm - highway!) > 8) for (const z of [-3, 3]) b.cyl(0.55, 0.55, y - 1.6 - g + 1, 10, off(at(tm, (y - 1.6 + g - 1) / 2), 0, z), '#aaa397', 'concrete');
    }
  }
  const out = b.build(M());
  out.position.set(ox, 0, oz);
  return out;
}

// ---------------------------------------------------------------- container depot / port

export function buildYard(route: Route, y: YardDef): THREE.Group {
  const f = newFrame();
  route.alignment.sample(y.km * 1000, f);
  const ox = f.x, oz = f.z;
  const group = new THREE.Group();
  group.position.set(ox, 0, oz);
  const b = new GeoBatch();
  const r = rng(y.km * 977);
  const at = (km: number, lat: number) => {
    route.alignment.sampleOffset(km * 1000, y.side * lat, f);
    return { x: f.x - ox, y: f.y - 0.15, z: f.z - oz, ry: -f.heading };
  };
  const box = (km: number, lat: number, w: number, h: number, d: number, base: number, color: string, key = 'std', rx = 0) => {
    const p = at(km, lat);
    b.box(w, h, d, mat(p.x, p.y + base + h / 2, p.z, p.ry, rx * y.side), color, key);
  };

  // containers: one instanced mesh per shipping line
  const lines = [0, 1, 2].map(i => ({ ...looseContainer(i), mats: [] as THREE.Matrix4[], cols: [] as THREE.Color[] }));
  const q = new THREE.Quaternion(), e = new THREE.Euler(), one = new THREE.Vector3(1, 1, 1);
  const container = (x: number, yy: number, z: number, ry: number) => {
    const l = lines[Math.floor(r() * 3)];
    l.mats.push(new THREE.Matrix4().compose(new THREE.Vector3(x, yy + 1.3, z), q.setFromEuler(e.set(0, ry, 0)), one));
    l.cols.push(new THREE.Color(TINTS[Math.floor(r() * TINTS.length)]));
  };

  // stack blocks: six rows wide, seven bays long, one to four high, with truck lanes between
  const port = y.type === 'port';
  const blocks = [32, 58, 84];
  const k0 = y.fromKm + 0.12, k1 = y.toKm - 0.12;
  for (let km = k0; km < k1 - 0.09; km += 0.102) {
    for (const bc of blocks) {
      for (let bay = 0; bay < 7; bay++) for (let row = 0; row < 6; row++) {
        const u = r();
        const tiers = u < 0.12 ? 0 : u < 0.3 ? 1 : u < 0.6 ? 2 : u < 0.86 ? 3 : 4;
        const p = at(km + (bay * 12.6 + 6.3) / 1000, bc + (row - 2.5) * 2.75);
        for (let k = 0; k < tiers; k++) container(p.x, p.y + k * 2.6, p.z, p.ry);
      }
      // a gantry crane straddling the block every few groups
      if (r() < 0.35) rtg(km + 0.03 + r() * 0.04, bc);
    }
    // high-mast lights between blocks
    const hm = at(km + 0.05, blocks[0] + 13);
    b.cyl(0.25, 0.45, 30, 8, mat(hm.x, hm.y + 15, hm.z), '#8a9096', 'metal');
    b.cyl(1.6, 1.6, 0.5, 10, mat(hm.x, hm.y + 30, hm.z), '#fff3c4', 'lamp');
  }
  function rtg(km: number, bc: number) {
    const Y = '#e3b021';
    for (const lat of [bc - 10, bc + 10]) {
      for (const d of [-3.6, 3.6]) box(km + d / 1000, lat, 0.9, 19, 0.9, 0.9, Y, 'metal');
      box(km, lat, 9, 0.9, 1.4, 0, Y, 'metal');                               // sill beam
      for (const d of [-3.6, 3.6]) box(km + d / 1000, lat, 1.4, 1.2, 0.8, 0, '#1d1d1d');  // tyres
    }
    for (const d of [-3.6, 3.6]) box(km + d / 1000, bc, 1.2, 1.6, 21.8, 19.9, Y, 'metal');   // girders across the block
    box(km, bc + 3, 4.5, 2.2, 3.2, 19, '#d8d8d0', 'metal');                         // trolley
    box(km, bc + 9, 2.4, 2.2, 2.4, 15.5, '#e9e9e2', 'metal');                       // cab
    box(km, bc + 9, 2.42, 0.9, 2.42, 16.6, '#22303a', 'glass');
  }

  // parked trucks along the lanes, each with a container on its trailer
  for (let i = 0; i < 18; i++) {
    const km = k0 + r() * (k1 - k0), lane = blocks[Math.floor(r() * blocks.length)] + 12.5;
    box(km + 0.009, lane, 2.4, 2.9, 2.5, 0.5, ['#c0392b', '#e6e6e6', '#2e6ca4', '#d68a1b'][i % 4]);
    box(km + 0.009, lane, 2.42, 0.9, 2.52, 2.0, '#26313a', 'glass');
    box(km, lane, 13, 0.5, 2.5, 0.9, '#2b2b2b', 'metal');
    for (const d of [-0.005, 0.004, 0.0095]) box(km + d, lane, 1.0, 1.0, 2.6, 0, '#151515');
    const p = at(km, lane);
    container(p.x, p.y + 1.4, p.z, p.ry);
  }

  // gate, office and a maintenance shed at the near end
  box(y.fromKm + 0.05, 30, 24, 8, 14, 0, '#dfe3e6', 'wall');
  box(y.fromKm + 0.05, 30, 24.2, 1.4, 14.2, 3.2, '#34505f', 'glass');
  box(y.fromKm + 0.05, 30, 24.2, 1.4, 14.2, 6.0, '#34505f', 'glass');
  box(y.fromKm + 0.12, 70, 40, 11, 26, 0, '#9fa8ad', 'sheet');
  box(y.fromKm + 0.12, 70, 40.4, 0.5, 26.4, 11, '#6f7c84', 'sheet');

  if (port) {
    const water = route.rivers.find(rv => rv.id === 'Sea')?.water ?? at(y.km, 0).y - 3;
    const W = y.widthM;
    // quay deck: a concrete apron along the water's edge with fenders and bollards
    for (let km = y.fromKm; km < y.toKm; km += 0.05) {
      const p = at(km + 0.025, W - 16);
      b.box(50.2, p.y - water + 9, 36, mat(p.x, (p.y + water - 9) / 2, p.z, p.ry), '#a8a39a', 'concrete');
      for (let d = 0; d < 50; d += 12.5) {
        box(km + d / 1000, W + 1.6, 0.5, 2.5, 0.6, -2.6, '#1b1b1b');                  // fender
        box(km + (d + 6) / 1000, W - 0.8, 0.6, 0.7, 0.6, 0, '#2a2a2a', 'metal');      // bollard
      }
    }
    // ship-to-shore cranes along the berth
    const ship0 = y.km - 0.05;
    for (const d of [-0.36, -0.21, -0.06, 0.09, 0.24]) sts(ship0 + d, W, water);
    ship(ship0, W, water);
    // lighthouse on a rock off the harbour entrance
    const lh = at(Math.min(y.toKm, route.lengthKm - 0.2), W + 520);
    b.cyl(16, 22, 9, 10, mat(lh.x, water + 1.5, lh.z), '#6e665c', 'stone');
    for (let k = 0; k < 4; k++) b.cyl(3.4 - k * 0.25, 3.6 - k * 0.25, 6.5, 14, mat(lh.x, water + 9.25 + k * 6.5, lh.z), k % 2 ? '#c63b2f' : '#f2f2ee');
    b.cyl(4.3, 4.3, 0.4, 14, mat(lh.x, water + 32, lh.z), '#2b2b2b', 'metal');
    b.cyl(1.9, 1.9, 2.6, 10, mat(lh.x, water + 33.5, lh.z), '#fff3c4', 'lamp');
    b.cyl(0, 2.3, 1.6, 10, mat(lh.x, water + 35.6, lh.z), '#c63b2f', 'metal');
  }

  function sts(km: number, W: number, water: number) {
    const C = '#2f6fa3', Wt = '#e8e8e4';
    for (const lat of [W - 30, W - 4]) for (const d of [-8, 8]) box(km + d / 1000, lat, 1.5, 46, 1.5, 0, C, 'metal');
    for (const lat of [W - 30, W - 4]) box(km, lat, 17.5, 1.6, 1.6, 44.5, C, 'metal');
    for (const d of [-8, 8]) box(km + d / 1000, W - 17, 1.4, 2, 27.5, 44, C, 'metal');
    // boom out over the berth and backreach over the quay
    for (const d of [-4.5, 4.5]) box(km + d / 1000, W + 20, 1.1, 2.4, 110, 46.5, Wt, 'metal');
    box(km, W - 20, 12, 5.5, 14, 46, Wt, 'metal');                                       // machinery house
    for (const d of [-4.5, 4.5]) box(km + d / 1000, W - 12, 1.0, 26, 1.0, 46, C, 'metal'); // A-frame towers
    box(km, W - 12, 10, 1.2, 1.2, 71.5, C, 'metal');
    // forestays to the boom tip and backstays to the backreach (tilted across the line)
    for (const [l0, l1] of [[W - 12, W + 70], [W - 12, W - 34]] as const) {
      const lm = (l0 + l1) / 2, dz = l1 - l0, dy = 46.5 - 72, len = Math.hypot(dz, dy);
      for (const d of [-4.5, 4.5]) box(km + d / 1000, lm, 0.35, len, 0.35, (72 + 46.5) / 2 - len / 2, C, 'metal', Math.atan2(dz, dy));
    }
    box(km, W + 34, 4, 2.4, 6, 43.5, '#d8d8d0', 'metal');                                // trolley
    box(km, W + 34, 3.2, 2.4, 3, 41, '#e9e9e2', 'metal');
    box(km, W + 34, 3.22, 1.0, 3.02, 42.2, '#22303a', 'glass');
    box(km, W + 34, 12.4, 0.6, 2.6, water - at(km, 0).y + 21, '#d6b21c', 'metal');      // spreader
  }

  function ship(km: number, W: number, water: number) {
    const lat = W + 28, B = 36, L = 280;
    const p = at(km, lat), base = water - at(km, lat).y;
    const local = (dx: number, yy: number, dzz: number) => mat(p.x, p.y + base + yy, p.z, p.ry).multiply(mat(dx, 0, dzz * y.side));
    b.box(L, 18, B, local(0, -2, 0), '#1f3550', 'metal');
    b.box(L + 0.4, 1.2, B + 0.4, local(0, -10.3, 0), '#8a2b22', 'metal');                // boot top
    b.box(B / Math.SQRT2, 18, B / Math.SQRT2, local(L / 2, -2, 0).multiply(mat(0, 0, 0, Math.PI / 4)), '#1f3550', 'metal');  // bow
    b.box(L, 0.5, B - 0.6, local(0, 7.1, 0), '#7a2a24', 'metal');                         // deck
    // superstructure aft: accommodation block, bridge with wings, funnel
    b.box(16, 24, 30, local(-L / 2 + 22, 19, 0), '#f1f1ec');
    b.box(16.2, 1.6, 30.2, local(-L / 2 + 22, 28.5, 0), '#24323c', 'glass');
    b.box(6, 1.6, B + 4, local(-L / 2 + 26, 30, 0), '#f1f1ec');
    b.box(7, 11, 6, local(-L / 2 + 10, 34, 0), '#e8e2d6');
    b.box(7.1, 2.4, 6.1, local(-L / 2 + 10, 37.5, 0), '#c63b2f');
    // containers on deck: fuller amidships
    for (let bay = 0; bay < 17; bay++) for (let row = 0; row < 12; row++) {
      const x = -L / 2 + 42 + bay * 12.8, z = (row - 5.5) * 2.55;
      const tiers = Math.max(0, Math.round(5 - Math.abs(row - 5.5) * 0.35 - r() * 1.8 - (bay > 14 ? 2 : 0)));
      for (let k = 0; k < tiers; k++) {
        const m = local(x, 7.35 + k * 2.6, z);
        const v = new THREE.Vector3().setFromMatrixPosition(m);
        container(v.x, v.y, v.z, p.ry);
      }
    }
  }

  for (const l of lines) {
    if (!l.mats.length) continue;
    const im = new THREE.InstancedMesh(l.geo, l.mat, l.mats.length);
    l.mats.forEach((m, i) => { im.setMatrixAt(i, m); im.setColorAt(i, l.cols[i]); });
    im.castShadow = im.receiveShadow = true;
    im.computeBoundingSphere();
    group.add(im);
  }
  group.add(b.build(M()));
  return group;
}

// ---------------------------------------------------------------- hill fort

export function buildFort(route: Route, field: TerrainField, km: number): THREE.Group {
  const f = newFrame();
  // the highest ground within a kilometre of the line, but not right beside it
  let best = { x: 0, z: 0, h: -Infinity };
  for (let d = -0.6; d <= 0.6; d += 0.1) for (const side of [-1, 1]) for (let lat = 320; lat <= 950; lat += 45) {
    route.alignment.sampleOffset((km + d) * 1000, side * lat, f);
    const h = field.height(f.x, f.z);
    if (h > best.h) best = { x: f.x, z: f.z, h };
  }
  const C = best;
  const b = new GeoBatch();
  const r = rng(km * 131);
  const g = (x: number, z: number) => field.height(C.x + x, C.z + z);

  // curtain wall following the hilltop, with round bastions at the corners
  const n = 11, R = 62;
  const pts = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2, rr = R * (0.82 + r() * 0.36);
    return { x: Math.cos(a) * rr, z: Math.sin(a) * rr };
  });
  for (let i = 0; i < n; i++) {
    const a = pts[i], c = pts[(i + 1) % n];
    const len = Math.hypot(c.x - a.x, c.z - a.z), ry = -Math.atan2(c.z - a.z, c.x - a.x);
    const pieces = Math.ceil(len / 6);
    for (let k = 0; k < pieces; k++) {
      const t = (k + 0.5) / pieces, x = a.x + (c.x - a.x) * t, z = a.z + (c.z - a.z) * t, gy = g(x, z);
      b.box(len / pieces + 0.3, 12, 2.6, mat(x, gy + 3, z, ry), SANDSTONE, 'stone');
      for (let m = 0; m < len / pieces - 0.8; m += 1.7) {
        const mx = -len / pieces / 2 + 0.6 + m;
        b.box(0.9, 1.0, 0.7, mat(x, gy + 9.5, z, ry).multiply(mat(mx, 0, 1.0)), SANDSTONE, 'stone');
      }
    }
    const gy = g(a.x, a.z);
    b.cyl(6.5, 7.5, 17, 14, mat(a.x, gy + 4.5, a.z), '#bf8b55', 'stone');
    for (let k = 0; k < 10; k++) {
      const ang = (k / 10) * Math.PI * 2;
      b.box(1, 1.1, 1, mat(a.x + Math.cos(ang) * 6.1, gy + 13.5, a.z + Math.sin(ang) * 6.1, -ang), SANDSTONE, 'stone');
    }
  }
  // gate: two towers and an arch lintel on the first wall
  const ga = pts[0], gb = pts[1], gx = (ga.x + gb.x) / 2, gz = (ga.z + gb.z) / 2, gry = -Math.atan2(gb.z - ga.z, gb.x - ga.x), gg = g(gx, gz);
  for (const s of [-5, 5]) b.box(5, 16, 5, mat(gx, gg + 7, gz, gry).multiply(mat(s, 0, 0)), '#bf8b55', 'stone');
  b.box(6, 3, 3, mat(gx, gg + 12.5, gz, gry), SANDSTONE, 'stone');

  // palace: stepped blocks with domed pavilions (chhatris) and balconies; a temple spire beside it
  const cy = g(0, 0);
  b.box(30, 16, 20, mat(0, cy + 6, 0), '#d2a46c', 'stone');
  b.box(20, 7, 13, mat(-2, cy + 17.5, 0), '#d6aa72', 'stone');
  for (let i = -12; i <= 12; i += 4) b.box(2.2, 1.6, 1.4, mat(i, cy + 10, 10.5), '#b7834f', 'stone');
  const dome = new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  for (const [x, z, s] of [[-10, -5, 2.2], [6, -5, 2.2], [-10, 5, 2.2], [6, 5, 2.2], [-2, 0, 3.6]] as const) {
    const top = cy + 21;
    for (const [px, pz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) b.box(0.4, 2.6, 0.4, mat(x + px * s * 0.75, top + 1.3, z + pz * s * 0.75), '#e1bd8a', 'stone');
    b.box(s * 2.1, 0.4, s * 2.1, mat(x, top + 2.8, z), '#d6aa72', 'stone');
    b.add(dome, mat(x, top + 3.0, z, 0, 0, 0, s, s * 1.1, s), '#e8cfa6', 'stone');
  }
  const tx = 22, tz = -14, tg = g(tx, tz);
  b.box(9, 6, 9, mat(tx, tg + 2, tz), '#e3c79c', 'stone');
  b.add(new THREE.CylinderGeometry(0.4, 4.2, 13, 8), mat(tx, tg + 11.5, tz), '#e9d2ad', 'stone');
  b.cyl(0.05, 0.05, 5, 4, mat(tx, tg + 20, tz), '#5a4a3a');
  b.box(0.05, 1.2, 2, mat(tx, tg + 21.8, tz + 1), '#e0582a');
  // a few houses of the old town on the slope below the gate
  for (let i = 0; i < 14; i++) {
    const a = Math.atan2(gz, gx) + (r() - 0.5) * 1.2, d = R + 15 + r() * 60;
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    b.box(5 + r() * 4, 4 + r() * 3, 5 + r() * 3, mat(x, g(x, z) + 1.5, z, r() * 3), r() < 0.5 ? '#e8d9bf' : '#d9b98c', 'wall');
  }
  const out = b.build(M());
  out.position.set(C.x, 0, C.z);
  return out;
}
