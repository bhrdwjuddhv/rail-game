import * as THREE from 'three/webgpu';
import { GeoBatch, mat } from '../../core/GeoBatch';
import { uvToRect } from '../../core/Textures';
import { cellQuad } from '../scenery/Props';
import { lifeCells, type LifeCell } from '../scenery/lifeKit';

/**
 * The road vehicles (original designs, no makes or badges): each model as up to four geometries - its body
 * (vertex colours, tinted per vehicle where it is painted white), its painted panels from the vehicle pack (truck
 * art and sides, bus liveries, auto colours), its lamps (head, tail, a truck's markers; lit at night) and the pool
 * its headlights throw on the road - plus a stripped-down body for far away (no wheels, windows or panels: the
 * panels' main colour painted in instead). Local frame: x forward, y up, z to the right; standing on y 0.
 */
export type VehicleType = 'hatch' | 'sedan' | 'suv' | 'taxi' | 'truck' | 'tanker' | 'container' | 'carcarrier' | 'bus' | 'sleeper'
  | 'tempo' | 'tractor' | 'auto' | 'bike' | 'cart' | 'cycle' | 'rickshaw' | 'cow';

export interface VehicleModel {
  type: VehicleType; variant: number;
  /** length (m), top speed range (km/h), acceleration (m/s^2) */
  length: number; kmph: [number, number]; accel: number;
  /** painted white where the vehicle's own colour goes (tinted per vehicle) */
  tinted: boolean;
  /** keeps to the edge of the road (slow: on the shoulder where there is one) */
  edge: boolean;
  body: THREE.BufferGeometry; far: THREE.BufferGeometry; deco: THREE.BufferGeometry | null; lamps: THREE.BufferGeometry | null; pool: boolean;
}

const SPEC: Record<VehicleType, { length: number; kmph: [number, number]; accel: number; tinted: boolean; edge?: boolean; pool?: boolean }> = {
  hatch: { length: 3.8, kmph: [75, 100], accel: 2.4, tinted: true },
  sedan: { length: 4.5, kmph: [80, 110], accel: 2.4, tinted: true },
  suv: { length: 4.7, kmph: [80, 105], accel: 2.2, tinted: true },
  taxi: { length: 4.4, kmph: [70, 95], accel: 2.2, tinted: false },
  truck: { length: 8.6, kmph: [50, 70], accel: 0.8, tinted: false },
  tanker: { length: 10.5, kmph: [45, 60], accel: 0.7, tinted: false },
  container: { length: 15.5, kmph: [50, 65], accel: 0.7, tinted: true },
  carcarrier: { length: 18, kmph: [50, 65], accel: 0.7, tinted: false },
  bus: { length: 11, kmph: [60, 80], accel: 1.1, tinted: false },
  sleeper: { length: 12, kmph: [65, 85], accel: 1.1, tinted: false },
  tempo: { length: 4.4, kmph: [40, 55], accel: 1.2, tinted: true },
  tractor: { length: 8.2, kmph: [25, 35], accel: 0.8, tinted: false, edge: true },
  auto: { length: 2.8, kmph: [35, 50], accel: 1.6, tinted: false },
  bike: { length: 2.0, kmph: [45, 75], accel: 2.6, tinted: true, pool: false },
  cart: { length: 5.5, kmph: [8, 10], accel: 0.4, tinted: false, edge: true, pool: false },
  cycle: { length: 1.8, kmph: [12, 18], accel: 0.6, tinted: true, edge: true, pool: false },
  rickshaw: { length: 2.6, kmph: [10, 15], accel: 0.6, tinted: false, edge: true, pool: false },
  cow: { length: 2.2, kmph: [0, 0], accel: 1, tinted: false, pool: false },
};

/** how many variants each type has */
export const VARIANTS: Record<VehicleType, number> = {
  hatch: 1, sedan: 1, suv: 1, taxi: 2, truck: 12, tanker: 2, container: 2, carcarrier: 1, bus: 3, sleeper: 2,
  tempo: 2, tractor: 2, auto: 3, bike: 3, cart: 1, cycle: 2, rickshaw: 1, cow: 2,
};

const DARK = '#1c262e', TYRE = '#1a1a1a', CHROME = '#c9ccd0';
const CABS = ['#d1452b', '#e3891c', '#2f6db5', '#2e8b57', '#c9a227', '#8e3b8f'];
const SIDE_COL = ['#c8402a', '#d9661c', '#2a5fae'];
const LIVERY_COL = ['#c0242a', '#2a62b8', '#1f8a3a', '#e2502a'];

let models: Map<string, VehicleModel> | null = null;
export const modelKey = (t: VehicleType, v: number) => `${t}:${v}`;

export function vehicleModels() {
  if (models) return models;
  models = new Map();
  for (const t of Object.keys(SPEC) as VehicleType[]) for (let v = 0; v < VARIANTS[t]; v++) {
    const full = build(t, v, false), far = build(t, v, true);
    const s = SPEC[t];
    models.set(modelKey(t, v), {
      type: t, variant: v, length: s.length, kmph: s.kmph, accel: s.accel, tinted: s.tinted, edge: !!s.edge, pool: s.pool !== false && t !== 'cow',
      body: full.geometry('std')!, far: far.geometry('std')!, deco: full.geometry('life-vehicle'), lamps: full.geometry('lamps'),
    });
  }
  return models;
}

const cell = (name: string, i: number): LifeCell | undefined => { const l = lifeCells('life/vehicle-pack', name); return l.length ? l[((i % l.length) + l.length) % l.length] : undefined; };

function build(t: VehicleType, v: number, lod: boolean) {
  const b = new GeoBatch();
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, c: string, key = 'std') => b.box(w, h, d, mat(x, y, z), c, key);
  const wheel = (x: number, z: number, r: number, wdt = 0.25) => { if (!lod) b.cyl(r, r, wdt, 10, mat(x, r, z, 0, Math.PI / 2), TYRE); };
  const wheels = (xs: number[], z: number, r: number) => { for (const x of xs) for (const s of [-1, 1]) wheel(x, s * z, r); };
  const lamp = (x: number, y: number, z: number, c: string, sz = 0.16) => { b.box(0.06, sz, sz * 1.4, mat(x, y, z), c, 'lamps'); };
  const heads = (x: number, y: number, z: number) => { for (const s of [-1, 1]) lamp(x, y, s * z, '#fff4d6', 0.18); };
  const tails = (x: number, y: number, z: number) => { for (const s of [-1, 1]) lamp(x, y, s * z, '#ff2a1a', 0.16); };
  /** a painted panel from the vehicle pack (far away, or without the pack: the body's own colour shows) */
  const panel = (name: string, i: number, w: number, h: number, m: THREE.Matrix4) => {
    const c = cell(name, i);
    if (c && !lod) cellQuad(b, 'life-vehicle', c, w, h, m);
  };
  const car = (len: number, h0: number, cabin: [number, number, number], col: string) => {
    box(len, h0, 1.72, 0, 0.3 + h0 / 2, 0, col);
    box(cabin[0], cabin[1], 1.6, cabin[2], 0.3 + h0 + cabin[1] / 2, 0, col);
    if (!lod) { box(cabin[0] - 0.1, cabin[1] * 0.72, 1.63, cabin[2], 0.3 + h0 + cabin[1] * 0.45, 0, DARK); box(len + 0.02, 0.12, 1.5, 0, 0.42, 0, '#2a2a2a'); }
    wheels([len * 0.32, -len * 0.32], 0.78, 0.32);
    heads(len / 2 + 0.01, 0.3 + h0 * 0.7, 0.6); tails(-len / 2 - 0.01, 0.3 + h0 * 0.75, 0.62);
  };
  const cab = (x: number, col: string, w = 2.4, h = 2.3) => {
    box(2.1, h, w, x, 0.6 + h / 2, 0, col);
    box(2.15, 0.35, w + 0.04, x + 0.03, 0.6 + h - 0.05, 0, '#c0392b');                      // the painted brow
    if (!lod) { box(0.06, 0.8, w - 0.3, x + 1.06, 0.6 + h * 0.62, 0, DARK); box(0.1, 0.25, w, x + 1.08, 0.75, 0, CHROME); }
    heads(x + 1.08, 1.05, w / 2 - 0.3);
    // marker lamps over the windscreen (the decorated trucks' row of colours)
    for (let i = 0; i < 5; i++) lamp(x + 1.0, 0.6 + h + 0.1, -0.8 + i * 0.4, ['#ffb21e', '#2dff6a', '#ff3b2f', '#4aa8ff', '#ffb21e'][i], 0.1);
  };
  switch (t) {
    case 'hatch': car(3.8, 0.75, [2.0, 0.65, -0.25], '#ffffff'); break;
    case 'sedan': car(4.5, 0.7, [2.2, 0.62, -0.15], '#ffffff'); break;
    case 'suv': car(4.7, 0.95, [3.0, 0.75, -0.4], '#ffffff'); box(4.72, 0.25, 1.76, 0, 0.42, 0, '#3a3f44'); break;
    case 'taxi': {
      // a black-and-yellow city taxi, or a white tourist taxi
      const lower = v === 0 ? '#151515' : '#f2f2ee', upper = v === 0 ? '#f2c200' : '#f2f2ee';
      car(4.4, 0.72, [2.2, 0.62, -0.15], lower);
      box(2.21, 0.64, 1.61, -0.15, 0.3 + 0.72 + 0.31, 0, upper);
      if (!lod) box(0.5, 0.15, 0.25, -0.15, 1.72, 0, '#f2c200');
      break;
    }
    case 'truck': {
      // the painted truck: a coloured cab with its brow, the body's sides and tailboard painted (truck sides and
      // art), black tassels; loads: as it is, overloaded with hay, or under a tarpaulin
      const art = v % 4, side = v % 3, load = Math.floor(v / 4);
      cab(2.9, CABS[v % CABS.length]);
      box(6.0, 0.25, 2.3, -0.8, 0.75, 0, '#2a2a2a');
      box(5.6, 1.9, 2.4, -1.0, 1.85, 0, SIDE_COL[side]);
      for (const s of [-1, 1]) panel('trucksides', side, 5.6, 1.9, mat(-1.0, 1.85, s * 1.215, s < 0 ? Math.PI : 0));
      panel('truckart', art, 2.3, 1.9, mat(-3.81, 1.85, 0, -Math.PI / 2));
      if (load === 1) box(6.4, 2.0, 2.9, -1.1, 3.6, 0, '#d8b45a');                              // hay piled high over the sides
      if (load === 2) box(5.7, 0.9, 2.5, -1.0, 3.2, 0, ['#2f6db5', '#e67e22', '#2e8b57'][v % 3]); // tarpaulin over the load
      if (!lod) for (const z of [-1, -0.5, 0.5, 1]) box(0.04, 0.35, 0.04, -3.86, 0.75, z, '#111111');
      wheels([-2.6, -1.4, 2.9], 1.05, 0.5);
      tails(-3.85, 0.95, 1.0);
      for (const z of [-1.15, 1.15]) lamp(-3.84, 2.75, z, '#ffb21e', 0.1);
      break;
    }
    case 'tanker': {
      cab(4.0, CABS[(v + 2) % CABS.length]);
      box(8.2, 0.3, 2.2, -1.3, 0.8, 0, '#2a2a2a');
      b.add(new THREE.CylinderGeometry(1.15, 1.15, 7.8, lod ? 8 : 16), mat(-1.4, 2.1, 0, 0, 0, Math.PI / 2), v ? '#d9dcde' : '#eef0ee');
      for (const x of [-4.5, 1.6]) b.add(new THREE.CylinderGeometry(1.17, 1.17, 0.35, lod ? 8 : 16), mat(-1.4 + x * 0.6, 2.1, 0, 0, 0, Math.PI / 2), '#e2702a');
      wheels([-4.4, -3.2, 4.0], 1.05, 0.5);
      tails(-5.3, 0.95, 1.0);
      break;
    }
    case 'container': {
      // a trailer truck with a 20 or 40 foot box (the box tinted per truck)
      const L = v ? 12.2 : 6.1;
      cab(6.6, CABS[(v + 1) % CABS.length]);
      box(L + 1, 0.3, 2.4, 5.4 - (L + 1) / 2, 1.2, 0, '#2a2a2a');
      box(L, 2.6, 2.44, 5.3 - L / 2, 2.65, 0, '#ffffff');
      if (!lod) for (let x = 0; x < L; x += 0.6) box(0.06, 2.5, 2.46, 5.3 - L + 0.3 + x, 2.65, 0, '#dcdcdc');
      wheels([5.3 - L + 0.8, 5.3 - L + 2.0, 6.0, 7.2], 1.05, 0.5);
      tails(5.3 - L - 0.05, 1.0, 1.0);
      break;
    }
    case 'carcarrier': {
      cab(7.8, CABS[3]);
      for (const y of [1.2, 3.0]) box(15, 0.15, 2.5, 0, y, 0, '#6d7378');
      for (const x of [-7, 7]) for (const z of [-1.2, 1.2]) box(0.15, 2.0, 0.15, x, 2.2, z, '#6d7378');
      const cols = ['#c0392b', '#ecf0f1', '#2c3e50', '#7f8c8d', '#2980b9', '#f39c12'];
      for (let i = 0; i < 6; i++) { const x = -5 + (i % 3) * 4.6, y = i < 3 ? 1.3 : 3.1; box(4.0, 0.6, 1.7, x, y + 0.3, 0, cols[i]); box(2.0, 0.5, 1.55, x - 0.2, y + 0.85, 0, cols[i]); }
      wheels([-6.5, -5.3, 8.8], 1.05, 0.5);
      tails(-7.6, 0.95, 1.0);
      break;
    }
    case 'bus': case 'sleeper': {
      // a state bus in its corporation's colours, or a private sleeper coach (taller, painted, lit up at night)
      const sl = t === 'sleeper', L = sl ? 12 : 11, H = sl ? 3.4 : 2.7, liv = sl ? 3 : v;
      box(L, H, 2.5, 0, 0.45 + H / 2, 0, LIVERY_COL[liv]);
      for (const s of [-1, 1]) panel('bus', liv, L * 0.98, H * 0.92, mat(0, 0.45 + H / 2, s * 1.26, s < 0 ? Math.PI : 0));
      if (!lod) { box(0.06, 1.1, 2.3, L / 2 + 0.02, 0.45 + H - 0.9, 0, DARK); box(0.05, 0.7, 2.2, -L / 2 - 0.02, 0.45 + H - 0.8, 0, DARK); }
      wheels([-L * 0.3, L * 0.3], 1.1, 0.5);
      heads(L / 2 + 0.03, 0.85, 0.95); tails(-L / 2 - 0.03, 0.9, 1.0);
      if (sl) for (let i = 0; i < 8; i++) lamp(L / 2 - 0.4 - i * 1.5, 0.45 + H + 0.02, 1.25, ['#ff3b2f', '#4aa8ff', '#2dff6a', '#ffb21e'][i % 4], 0.09);
      break;
    }
    case 'tempo': {
      // a mini goods carrier: a small cab, an open bed with sacks and crates
      box(1.4, 1.5, 1.6, 1.4, 1.2, 0, '#ffffff');
      if (!lod) box(0.05, 0.6, 1.4, 2.11, 1.45, 0, DARK);
      box(2.8, 0.5, 1.7, -0.6, 0.8, 0, '#ffffff');
      for (let i = 0; i < 4; i++) box(0.6, 0.45, 0.5, -1.6 + i * 0.6, 1.3, (i % 2) * 0.5 - 0.25, v ? '#d4b88a' : '#8a6a4a');
      wheels([-1.2, 1.4], 0.8, 0.32);
      heads(2.12, 0.9, 0.55); tails(-2.02, 0.8, 0.7);
      break;
    }
    case 'tractor': {
      // a red tractor and its trolley (bricks or a hay heap)
      box(2.2, 0.9, 1.0, 2.8, 1.2, 0, '#c62828');
      box(1.0, 1.3, 1.2, 1.4, 1.6, 0, '#c62828');
      if (!lod) b.cyl(0.06, 0.06, 1.2, 6, mat(2.4, 2.2, 0.3), '#333333');
      for (const s of [-1, 1]) { if (!lod) b.cyl(0.75, 0.75, 0.4, 12, mat(1.4, 0.75, s * 0.85, 0, Math.PI / 2), TYRE); wheel(3.4, s * 0.6, 0.42); }
      box(3.6, 0.9, 2.0, -1.4, 1.1, 0, '#3f6db5');
      if (v) box(3.4, 1.3, 1.8, -1.4, 2.1, 0, '#d8b45a'); else for (let i = 0; i < 4; i++) box(3.2, 0.25, 1.7, -1.4, 1.65 + i * 0.25, 0, '#a85638');
      wheels([-1.4], 1.0, 0.5);
      heads(3.95, 1.2, 0.35); tails(-3.25, 0.9, 0.9);
      break;
    }
    case 'auto': {
      // an autorickshaw in a city's colours: green and yellow, black and yellow, all yellow
      const bodyCell = [1, 2, 0][v], topCell = [0, 0, 0][v], bodyCol = ['#2e7d32', '#1c1c1c', '#f2c200'][v];
      box(2.6, 1.0, 1.35, 0, 0.85, 0, bodyCol);
      box(2.4, 0.15, 1.4, -0.1, 1.75, 0, '#f9d71c');
      if (!lod) {
        box(0.1, 0.8, 1.3, 0.9, 1.3, 0, DARK);
        for (const s of [-1, 1]) { const c = cell('auto', bodyCell); if (c) cellQuad(b, 'life-vehicle', c, 2.5, 0.55, mat(0, 0.75, s * 0.69, s < 0 ? Math.PI : 0)); }
        const top = cell('auto', topCell); if (top) cellQuad(b, 'life-vehicle', top, 2.3, 1.36, mat(-0.1, 1.84, 0, 0, -Math.PI / 2));
      }
      wheels([-0.8], 0.6, 0.25); wheel(1.1, 0, 0.25);
      heads(1.31, 0.95, 0.0); tails(-1.31, 0.8, 0.55);
      break;
    }
    case 'bike': {
      // a motorcycle or scooter with its rider (a helmet, now and then a pillion)
      box(1.8, 0.35, 0.3, 0, 0.7, 0, '#ffffff');
      if (!lod) { wheel(0.7, 0, 0.3, 0.1); wheel(-0.7, 0, 0.3, 0.1); }
      b.cyl(0.18, 0.2, 0.7, 6, mat(-0.1, 1.3, 0), ['#2f6db5', '#c0392b', '#f4f1ec'][v]);
      b.add(new THREE.SphereGeometry(0.15, 8, 6), mat(-0.05, 1.8, 0), v === 1 ? '#c0392b' : '#111111');
      if (v === 2) { b.cyl(0.16, 0.18, 0.6, 6, mat(-0.55, 1.25, 0), '#e67e22'); b.add(new THREE.SphereGeometry(0.13, 8, 6), mat(-0.55, 1.7, 0), '#1a1a1a'); }
      lamp(0.92, 0.95, 0, '#fff4d6', 0.14); lamp(-0.92, 0.8, 0, '#ff2a1a', 0.1);
      break;
    }
    case 'cart': {
      // a bullock cart: two white bullocks yoked, the cart loaded with sacks or straw, the driver
      box(2.6, 0.2, 1.6, -0.8, 1.0, 0, '#8d6e63');
      if (!lod) for (const s of [-1, 1]) b.cyl(0.7, 0.7, 0.12, 10, mat(-0.8, 0.7, s * 0.9, 0, Math.PI / 2), '#5d4037');
      for (const s of [-0.45, 0.45]) { box(1.7, 0.9, 0.7, 1.6, 1.15, s, '#e0dccf'); box(0.5, 0.5, 0.4, 2.6, 1.5, s, '#e0dccf'); for (const x of [1.0, 2.2]) box(0.15, 0.7, 0.15, x, 0.35, s, '#d8d2c4'); }
      box(2.4, 0.08, 0.08, 1.0, 1.2, 0, '#5d4037');
      box(2.2, 0.6, 1.5, -0.9, 1.4, 0, '#d8b45a');
      lamp(-2.11, 1.0, 0, '#ff2a1a', 0.12);
      break;
    }
    case 'cycle': {
      if (!lod) { wheel(0.55, 0, 0.34, 0.06); wheel(-0.55, 0, 0.34, 0.06); }
      box(1.1, 0.06, 0.06, 0, 0.6, 0, '#2c3e50');
      b.cyl(0.17, 0.19, 0.65, 6, mat(-0.15, 1.25, 0), v ? '#f4f1ec' : '#2e86c1');
      b.add(new THREE.SphereGeometry(0.13, 8, 6), mat(-0.1, 1.7, 0), '#1a1a1a');
      lamp(-0.85, 0.6, 0, '#ff2a1a', 0.08);
      break;
    }
    case 'rickshaw': {
      box(1.6, 0.06, 0.06, 0.2, 0.6, 0, '#2c3e50');
      box(0.8, 0.12, 1.1, -0.6, 0.85, 0, '#7b241c');
      if (!lod) { wheel(1.0, 0, 0.33, 0.05); for (const s of [-1, 1]) wheel(-0.6, s * 0.5, 0.33, 0.05); }
      const c = cell('rickshaw', 0), hood = new THREE.CylinderGeometry(0.6, 0.6, 1.1, 10, 1, true, 0, Math.PI);
      if (c && !lod) b.add(uvToRect(hood, { u0: c.uv[0], v0: c.uv[1], u1: c.uv[2], v1: c.uv[3] }), mat(-0.6, 1.3, 0, 0, Math.PI / 2, 0), '#ffffff', 'life-vehicle');
      else b.add(hood, mat(-0.6, 1.3, 0, 0, Math.PI / 2, 0), '#7b241c');
      b.cyl(0.17, 0.19, 0.65, 6, mat(0.75, 1.25, 0), '#f4f1ec');
      b.add(new THREE.SphereGeometry(0.13, 8, 6), mat(0.8, 1.7, 0), '#1a1a1a');
      break;
    }
    case 'cow': {
      const c = v ? '#f2efe8' : '#8a6a4a';
      box(1.6, 0.75, 0.6, 0, 1.05, 0, c);
      box(0.5, 0.4, 0.35, 0.95, 1.25, 0, c);
      if (!lod) for (const x of [-0.6, 0.6]) for (const z of [-0.2, 0.2]) box(0.12, 0.7, 0.12, x, 0.35, z, c);
      if (!lod) for (const z of [-0.12, 0.12]) box(0.04, 0.25, 0.04, 1.05, 1.55, z, '#d8d2c4');
      break;
    }
  }
  return b;
}
