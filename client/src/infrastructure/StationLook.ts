import * as THREE from 'three/webgpu';
import { GeoBatch, hipRoof, mat } from '../core/GeoBatch';
import { labelTexture } from '../core/Textures';
import { biomeOf, type RegionData, type StationInfo } from '@rail/shared/track/Route';
import type { CanopyType, StationProfile } from '@rail/shared/track/StationProfile';

/**
 * What makes each ordinary station its own (its profile, data/stations): the building by class and colour
 * scheme, the platform roofs' kind, its one landmark, the stalls, the boards and the forecourt. Station.ts
 * builds the platforms, roofs and bridges and calls these; everything goes into the station's GeoBatch
 * (boards: label meshes).
 */
type At = (km: number, lat: number) => { x: number; y: number; z: number; ry: number; h: number };

export const SCHEMES = {
  'cream-maroon': { wall: '#efe2c6', trim: '#7b2230' },
  'yellow-red': { wall: '#f0c75a', trim: '#b23a2c' },
  'white-blue': { wall: '#f3f3ef', trim: '#2f5d8a' },
  stone: { wall: '#cbbfa9', trim: '#6b5640' },
} as const;

/** the building's walls and trim: the scheme's, in the region's material (sandstone in the desert, stone in the hills) */
export function stationColours(p: StationProfile, region: RegionData) {
  const s = SCHEMES[p.scheme], biome = biomeOf(region);
  const stone = p.scheme === 'stone' || region.stationStyle === 'stone' || biome === 'snow';
  const wall = biome === 'desert' && p.scheme !== 'white-blue' ? '#d8a868' : stone ? '#cfc6b6' : s.wall;
  return { wall, trim: biome === 'snow' ? '#5b3a24' : s.trim, key: stone ? 'stone' : 'wall' as 'stone' | 'wall', tiledRoof: biome === 'ghats' || biome === 'snow' || biome === 'coast' };
}

/** the platform roofs: their sheet colour (tinted onto the sheet or clay-tile texture) and their posts */
export function canopyLook(kind: CanopyType) {
  switch (kind) {
    case 'cast-iron': return { roof: new THREE.Color(0x6f8a7a), ridge: new THREE.Color(0x4f6a5a), post: '#2f4436', tiles: false };
    case 'steel': return { roof: new THREE.Color(0xc9cdd1), ridge: new THREE.Color(0x9aa1a7), post: '#8a939a', tiles: false };
    case 'tiled': return { roof: new THREE.Color(0xd8875a), ridge: new THREE.Color(0xa8583a), post: '#6e4b33', tiles: true };
    default: return { roof: new THREE.Color(0x7aa6d6), ridge: new THREE.Color(0x5b88b8), post: '#4d6b7a', tiles: false };
  }
}

/** how much of the platform its roofs cover (km either side of the middle): a halt's shelter ... a city's full length */
export function shelterHalfOf(p: StationProfile, pfFrom: number, pfTo: number) {
  return p.class === 'halt' ? 0.03 : p.class === 'rural' ? 0.07 : p.class === 'town' ? 0.13 : (pfTo - pfFrom) / 2 - 0.012;
}

export interface BuildingDims { len: number; dep: number; hgt: number }

/**
 * The station building by class: a halt's booking cabin; a one-storey rural building; a two-storey town one;
 * a city's three storeys with a clock tower over the booking hall and a porch on the road side. An arcade
 * faces the platforms; the trim (arches, bands, porch) is the scheme's colour.
 */
export function stationBuilding(b: GeoBatch, at: At, st: StationInfo, p: StationProfile, region: RegionData, bl: number, side: number, pfH: number) {
  const c = stationColours(p, region);
  const d: BuildingDims = p.class === 'halt' ? { len: 8, dep: 4.5, hgt: 3 } : p.class === 'rural' ? { len: 22, dep: 7.5, hgt: 3.6 } : p.class === 'town' ? { len: 38, dep: 9, hgt: 6 } : { len: 64, dep: 13, hgt: 9 };
  const { len, dep, hgt } = d, bb = at(st.km, bl), y0 = bb.y + pfH;
  b.box(len, hgt, dep, mat(bb.x, y0 + hgt / 2 - 0.2, bb.z, bb.ry), c.wall, c.key);
  // floor bands in the trim colour
  for (let f = 3; f < hgt - 0.5; f += 3) b.box(len + 0.1, 0.25, dep + 0.1, mat(bb.x, y0 + f, bb.z, bb.ry), c.trim);
  // arcade on the platform side
  const vl = bl - side * (dep / 2 + 1.6);
  for (let i = -len / 2 + 1.5; i <= len / 2 - 1.5; i += 3) {
    const q = at(st.km + i / 1000, vl);
    b.box(0.5, 3.4, 0.5, mat(q.x, q.y + pfH + 1.7, q.z, q.ry), '#f0e6d6');
  }
  const vq = at(st.km, vl);
  b.box(len, 0.35, 3.6, mat(vq.x, vq.y + pfH + 3.55, vq.z, vq.ry), c.trim);
  // windows on both long faces
  for (const face of [-1, 1]) for (let f = 0; f * 3 + 1.2 < hgt; f++) for (let i = -len / 2 + 2; i < len / 2 - 1; i += 3.2) {
    const q = at(st.km + i / 1000, bl + face * side * (dep / 2 + 0.03));
    b.box(1.2, 1.5, 0.06, mat(q.x, q.y + pfH + 1.4 + f * 3, q.z, q.ry), '#2b3640');
  }
  // roof: hipped clay tiles in the ghats and hills (and on small buildings), else a flat roof with a parapet and cornice
  if (c.tiledRoof || p.class === 'halt' || p.class === 'rural') b.add(hipRoof(len + 1.2, 2.2, dep + 1.2), mat(bb.x, y0 + hgt + 1.0, bb.z, bb.ry), '#ffffff', 'roof');
  else {
    b.box(len + 0.4, 0.5, dep + 0.4, mat(bb.x, y0 + hgt + 0.05, bb.z, bb.ry), c.trim);
    b.box(len + 0.2, 0.9, dep + 0.2, mat(bb.x, y0 + hgt + 0.7, bb.z, bb.ry), c.wall, c.key);
  }
  let clockY = y0 + hgt - 1.2;
  if (p.class === 'city') {
    // the booking hall's clock tower and the porch for cars on the road side
    b.box(9, hgt + 8, 9, mat(bb.x, y0 + (hgt + 8) / 2 - 0.2, bb.z, bb.ry), c.wall, c.key);
    b.box(9.6, 0.5, 9.6, mat(bb.x, y0 + hgt + 8, bb.z, bb.ry), c.trim);
    b.add(new THREE.SphereGeometry(3.4, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat(bb.x, y0 + hgt + 8.2, bb.z), c.trim);
    const pq = at(st.km, bl + side * (dep / 2 + 4));
    b.box(14, 0.6, 7, mat(pq.x, pq.y + pfH + 4.4, pq.z, pq.ry), c.trim);
    for (const dx of [-6.5, 6.5]) for (const dz of [-3, 3]) b.box(0.7, 4.4, 0.7, mat(pq.x, pq.y + pfH + 2.2, pq.z, pq.ry).multiply(mat(dx, 0, dz)), '#f0e6d6');
    clockY = y0 + hgt + 5;
  } else if (p.landmark === 'clock' && p.class !== 'halt') {
    // a clock turret on the roof (the heritage clock)
    b.box(3, 4, 3, mat(bb.x, y0 + hgt + 2, bb.z, bb.ry), c.wall, c.key);
    b.add(new THREE.ConeGeometry(2.4, 2.4, 4), mat(bb.x, y0 + hgt + 5.2, bb.z, bb.ry + Math.PI / 4), c.trim);
    clockY = y0 + hgt + 2.2;
  }
  // (a city's clock: on the tower's platform face)
  const cq = at(st.km, bl - side * (p.class === 'city' ? 4.55 : dep / 2 + 0.05));
  return { dims: d, clock: { x: cq.x, y: clockY, z: cq.z, ry: cq.ry + (side > 0 ? Math.PI : 0), scale: p.class === 'city' ? 1.8 : 1 } };
}

/** Stalls on the platforms (the profile's mix): a tea stall, snacks, a bookstall, fruit; at these km (with the platform mid) */
export function platformStalls(b: GeoBatch, top: At, p: StationProfile, spots: { km: number; mid: number }[]) {
  const look = { tea: ['#e67e22', '#c0392b'], snacks: ['#f1c40f', '#d35400'], books: ['#2e86c1', '#1b4f72'], fruit: ['#27ae60', '#1e8449'] } as const;
  p.stalls.forEach((kind, i) => {
    const s = spots[i];
    if (!s) return;
    const q = top(s.km, s.mid), [body, roof] = look[kind];
    b.box(2.6, 2.2, 1.8, mat(q.x, q.y + 1.1, q.z, q.ry), body);
    b.box(3.2, 0.1, 2.4, mat(q.x, q.y + 2.35, q.z, q.ry, 0, 0.1), roof);
    b.box(2.6, 0.1, 0.5, mat(q.x, q.y + 1.0, q.z, q.ry).multiply(mat(0, 0, 1.1)), '#8e5b33');
    // what it sells, on the counter and racks
    const goods = kind === 'books' ? ['#c0392b', '#2471a3', '#f4d03f', '#7d3c98'] : kind === 'fruit' ? ['#e74c3c', '#f39c12', '#f4d03f', '#82e0aa'] : kind === 'snacks' ? ['#f5b041', '#e59866', '#f7dc6f'] : ['#ecf0f1', '#a04000'];
    for (let k = 0; k < 6; k++) b.box(0.32, 0.22, 0.3, mat(q.x, q.y + 1.16, q.z, q.ry).multiply(mat(-1.0 + k * 0.4, 0, 1.0)), goods[k % goods.length]);
  });
}

/** A weighing machine and a heap of luggage on a town or city station's main platform. */
export function platformClutter(b: GeoBatch, top: At, p: StationProfile, km: number, lat: number) {
  if (p.class !== 'town' && p.class !== 'city') return;
  const q = top(km, lat);
  b.box(0.7, 1.9, 0.6, mat(q.x, q.y + 0.95, q.z, q.ry), '#c0392b');
  b.cyl(0.25, 0.25, 0.04, 16, mat(q.x, q.y + 1.5, q.z, q.ry).multiply(mat(0, 0, 0.31, 0, Math.PI / 2)), '#f4f4f0');
  b.box(0.7, 0.12, 0.7, mat(q.x, q.y + 0.06, q.z, q.ry).multiply(mat(0, 0, 0.55)), '#3d3d3d');
  const bags = ['#5d4037', '#1a5276', '#7d6608', '#4a235a', '#7b241c'];
  for (let i = 0; i < 6; i++) b.box(0.6 + (i % 3) * 0.15, 0.35, 0.45, mat(q.x, q.y + 0.18 + (i > 3 ? 0.35 : 0), q.z, q.ry).multiply(mat(2 + (i % 4) * 0.7, 0, 0.2 * (i % 2))), bags[i % bags.length]);
}

/**
 * The station's landmark: by the far end of the building-side platform (banyan, water tank, signal cabin,
 * view deck), on the roof (clock: stationBuilding) or in the forecourt behind the building (garden and
 * fountain, a plinthed steam loco, a well; a city's banyan too, its roofs covering the platforms).
 */
export function landmark(b: GeoBatch, at: At, st: StationInfo, p: StationProfile, bl: number, side: number, dims: BuildingDims, pfFrom: number, pfTo: number, pfMid: number, pfH: number) {
  const fore = (dkm: number, out: number) => at(st.km + dkm, bl + side * (dims.dep / 2 + out));
  switch (p.landmark) {
    case 'banyan': {
      const q = p.class === 'city' ? fore(-0.02, 14) : at(pfFrom + 0.035, pfMid), y = q.y + (p.class === 'city' ? 0 : pfH);
      b.cyl(1.6, 1.7, 0.5, 16, mat(q.x, y + 0.25, q.z), '#b9b2a6', 'concrete');
      b.cyl(0.8, 1.1, 5, 8, mat(q.x, y + 2.5, q.z), '#6b5340');
      for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; b.cyl(0.08, 0.1, 5.2, 5, mat(q.x + Math.cos(a) * 3.2, y + 2.6, q.z + Math.sin(a) * 3.2), '#7a604a'); }
      for (let i = 0; i < 7; i++) { const a = (i / 7) * Math.PI * 2, rr = i ? 4.2 : 0; b.add(new THREE.SphereGeometry(i ? 3.4 : 4.4, 10, 8), mat(q.x + Math.cos(a) * rr, y + 6.6 + (i % 2) * 0.8, q.z + Math.sin(a) * rr, 0, 0, 0, 1, 0.7, 1), i % 2 ? '#3f6b2f' : '#4c7a35'); }
      return;
    }
    case 'watertank': {
      // a steel tank on a trestle at the platform end (from the steam days)
      const q = at(pfFrom - 0.03, bl);
      for (const [dx, dz] of [[-1.8, -1.8], [1.8, -1.8], [-1.8, 1.8], [1.8, 1.8]]) b.box(0.3, 8, 0.3, mat(q.x, q.y + 4, q.z, q.ry).multiply(mat(dx, 0, dz)), '#4d4d4d', 'metal');
      b.box(5, 2.6, 5, mat(q.x, q.y + 9.3, q.z, q.ry), '#5b6066', 'metal');
      b.box(0.6, 6, 0.1, mat(q.x, q.y + 3, q.z, q.ry).multiply(mat(0, 0, 2.6)), '#3a3a3a', 'metal');
      return;
    }
    case 'signalcabin': {
      // a two-storey cabin by the line beyond the platform end: brick below, glazed lever room above, hipped roof
      const q = at(pfTo + 0.045, bl - side * 2);
      b.box(6, 3.2, 4, mat(q.x, q.y + 1.6, q.z, q.ry), '#a0522d', 'brick');
      b.box(6.2, 2.4, 4.2, mat(q.x, q.y + 4.4, q.z, q.ry), '#f0e6d6');
      b.box(5.6, 1.4, 4.24, mat(q.x, q.y + 4.6, q.z, q.ry), '#3d4a55');
      b.add(hipRoof(6.8, 1.6, 4.8), mat(q.x, q.y + 6.4, q.z, q.ry), '#ffffff', 'roof');
      return;
    }
    case 'viewdeck': {
      // a railed deck past the platform end, out over the valley side
      const q = at(pfTo + 0.02, bl), y = q.y + pfH;
      b.box(8, 0.3, 5, mat(q.x, y, q.z, q.ry), '#9c968c', 'concrete');
      for (const dz of [-2.5, 2.5]) b.box(8, 0.06, 0.06, mat(q.x, y + 1.0, q.z, q.ry).multiply(mat(0, 0, dz)), '#4d4d4d', 'metal');
      b.box(0.06, 0.06, 5, mat(q.x, y + 1.0, q.z, q.ry).multiply(mat(4, 0, 0)), '#4d4d4d', 'metal');
      for (let x = -4; x <= 4; x += 1) for (const dz of [-2.5, 2.5]) b.box(0.05, 1.0, 0.05, mat(q.x, y + 0.5, q.z, q.ry).multiply(mat(x, 0, dz)), '#4d4d4d', 'metal');
      for (const x of [-2, 2]) b.box(1.8, 0.45, 0.45, mat(q.x, y + 0.4, q.z, q.ry).multiply(mat(x, 0, 0)), '#5b4636');
      return;
    }
    case 'garden': {
      const q = fore(0, 9), y = q.y + 0.05;
      b.box(18, 0.1, 9, mat(q.x, y, q.z, q.ry), '#5c8a3a');
      for (const dz of [-4.5, 4.5]) b.box(18, 0.7, 0.5, mat(q.x, y + 0.35, q.z, q.ry).multiply(mat(0, 0, dz)), '#3d6b2a');
      b.cyl(1.8, 2, 0.6, 16, mat(q.x, y + 0.3, q.z), '#d8d2c4', 'concrete');
      b.cyl(0.3, 0.4, 1.4, 8, mat(q.x, y + 1, q.z), '#d8d2c4', 'concrete');
      b.cyl(1.6, 1.6, 0.05, 16, mat(q.x, y + 0.58, q.z), '#5d9fc9');
      const fl = ['#e74c3c', '#f1c40f', '#ecf0f1', '#e67e22'];
      for (let i = 0; i < 12; i++) b.box(0.6, 0.4, 0.6, mat(q.x, y + 0.2, q.z, q.ry).multiply(mat(-7.5 + (i % 6) * 3, 0, i < 6 ? -2.8 : 2.8)), fl[i % fl.length]);
      return;
    }
    case 'steamloco': {
      // a steam loco on a plinth in the forecourt: boiler, smokebox and chimney, cab, red-rimmed wheels
      const q = fore(0.03, 10), y = q.y + 1.0, m = (x: number, yy: number, z = 0, rz = 0) => mat(q.x, y, q.z, q.ry).multiply(mat(x, yy, z, 0, 0, rz));
      b.box(14, 1, 3.6, mat(q.x, q.y + 0.5, q.z, q.ry), '#b9b2a6', 'concrete');
      for (const z of [-0.76, 0.76]) b.box(13, 0.15, 0.1, m(0, 0.08, z), '#6d6d6d', 'metal');
      b.cyl(1.0, 1.0, 7, 14, m(1.2, 2.3, 0, Math.PI / 2), '#1d1f22', 'metal');
      b.cyl(1.05, 1.05, 1.2, 14, m(4.8, 2.3, 0, Math.PI / 2), '#2a2c2f', 'metal');
      b.cyl(0.35, 0.3, 1.4, 10, m(4.8, 3.9), '#1d1f22', 'metal');
      b.box(3, 3, 2.8, m(-3.6, 2.6), '#1d1f22', 'metal');
      b.box(3.4, 0.2, 3, m(-3.6, 4.2), '#2a2c2f', 'metal');
      for (const x of [-1.4, 0.4, 2.2]) for (const z of [-0.9, 0.9]) b.cyl(0.75, 0.75, 0.12, 16, m(x, 0.85, z, 0).multiply(mat(0, 0, 0, 0, Math.PI / 2)), '#8b1a1a', 'metal');
      b.box(9.5, 0.4, 2.6, m(0, 1.3), '#2a2c2f', 'metal');
      return;
    }
    case 'well': {
      const q = fore(-0.015, 7), y = q.y;
      b.cyl(1.5, 1.6, 0.9, 16, mat(q.x, y + 0.45, q.z), '#b5a58f', 'stone');
      b.cyl(1.2, 1.2, 0.05, 16, mat(q.x, y + 0.88, q.z), '#2c3e50');
      for (const s of [-1, 1]) b.box(0.2, 2.4, 0.2, mat(q.x, y + 1.2, q.z, q.ry).multiply(mat(s * 1.4, 0, 0)), '#6d4c33');
      b.box(3, 0.15, 0.15, mat(q.x, y + 2.35, q.z, q.ry), '#6d4c33');
      b.cyl(0.2, 0.2, 0.3, 10, mat(q.x, y + 2.1, q.z, q.ry, Math.PI / 2), '#5b5b5b', 'metal');
      return;
    }
    default: return; // clock: the turret or tower on the building
  }
}

/** The forecourt behind the building: an auto stand at a town; at a city a car park as well. */
export function forecourt(b: GeoBatch, at: At, st: StationInfo, p: StationProfile, bl: number, side: number, dims: BuildingDims) {
  if (p.class === 'halt') return;
  const q = (dkm: number, out: number) => at(st.km + dkm, bl + side * (dims.dep / 2 + out));
  const autos = p.class === 'rural' ? 2 : p.class === 'town' ? 4 : 7;
  for (let i = 0; i < autos; i++) {
    const a = q(0.012 + i * 0.0026, 4.5), m = mat(a.x, a.y, a.z, a.ry + Math.PI / 2);
    b.box(2.4, 0.5, 1.3, m.clone().multiply(mat(0, 0.6, 0)), '#2e7d32');
    b.box(2.3, 0.08, 1.35, m.clone().multiply(mat(-0.1, 1.85, 0)), '#f2c200');
    b.box(0.5, 0.9, 1.0, m.clone().multiply(mat(0.95, 1.1, 0, 0, 0, 0.25)), '#222');
  }
  if (p.class !== 'city') return;
  const car = ['#ecf0f1', '#7f8c8d', '#c0392b', '#2c3e50', '#2471a3', '#f4f6f7'];
  const lot = q(-0.03, 14);
  b.box(30, 0.05, 16, mat(lot.x, lot.y + 0.03, lot.z, lot.ry), '#5f6366', 'concrete');
  for (let i = 0; i < 14; i++) {
    const c = q(-0.044 + (i % 7) * 0.0042, i < 7 ? 9.5 : 18.5), m = mat(c.x, c.y, c.z, c.ry + Math.PI / 2);
    if ((i * 7) % 5 === 0) continue;
    b.box(4.2, 0.8, 1.8, m.clone().multiply(mat(0, 0.6, 0)), car[i % car.length]);
    b.box(2.4, 0.6, 1.6, m.clone().multiply(mat(-0.2, 1.3, 0)), '#3d4a55');
  }
}

/**
 * Boards: the platform numbers on posts at each platform's ends (black on yellow), "way out" by the building,
 * the height above sea level on the building-side platform, and the profile's own boards.
 */
export function signage(group: THREE.Group, b: GeoBatch, top: At, st: StationInfo, p: StationProfile, pfFrom: number, pfTo: number, mainMid: number, elevationM: number) {
  // a board on two posts (in the station's batch: no draw of their own), across the platform (read by people walking along it)
  const board = (text: string[], km: number, lat: number, w: number, h: number, bg: string, fg: string, up = 2.4) => {
    const q = top(km, lat), g = new THREE.Group();
    g.position.set(q.x, q.y, q.z);
    g.rotation.y = q.ry + Math.PI / 2;
    const t = labelTexture(text.join('|'), { bg, fg, w: Math.round(w * 128), h: Math.round(h * 128), lines: text, border: fg });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: t, side: THREE.DoubleSide, roughness: 0.6, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.08 }));
    m.position.y = up;
    g.add(m);
    for (const s of [-1, 1]) b.box(0.07, up + h / 2, 0.07, mat(q.x, q.y, q.z, g.rotation.y).multiply(mat(s * (w / 2 - 0.1), (up + h / 2) / 2, -0.05)), '#3d4247', 'metal');
    group.add(g);
  };
  for (const pf of st.platforms) {
    const mid = (pf.from + pf.to) / 2;
    for (const km of [pfFrom + 0.012, pfTo - 0.012]) board([pf.num], km, mid, 0.9, 0.9, '#f5d000', '#111111', 2.6);
  }
  board(['निकास', 'WAY OUT  →'], st.km - 0.012, mainMid, 1.8, 0.8, '#1e8449', '#ffffff');
  board(['समुद्र तल से ऊंचाई', `Height above MSL ${elevationM.toFixed(2)} m`], st.km + 0.05, mainMid, 2.4, 0.8, '#f5d000', '#111111');
  p.boards.forEach((t, i) => board([t], st.km + 0.075 + i * 0.012, mainMid, 2.6, 0.6, '#ffffff', '#1d3557'));
}
