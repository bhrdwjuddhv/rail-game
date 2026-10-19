import { hash2, rng } from '@rail/shared/util';
import { newFrame } from '@rail/shared/track/Chainage';
import { biomeOf, Route } from '@rail/shared/track/Route';
import type { TerrainField } from '../TerrainField';
import { inZone } from './BillboardSlots';
import { placeScenes } from './Scenes';
import { lifeCells, SHOP_VARIANTS } from './lifeKit';
import { BUILDING_TYPES, BuildingType, buildingFootprint, buildingLayout, BuildingStyle, buildingType, cellsOf, CITY_KM, STYLES, styleOfRegion } from './buildingKit';
import { roadAt } from '../roads/Highways';

/**
 * Billboard clear zones (BillboardSlots): nothing tall stands between the line
 * and a billboard's face, so it stays readable from the cab. Indexed by 100 m cell.
 */
const zoneCells = new Map<number, number[][]>();
const cellOf = (x: number, z: number) => (Math.floor(x / 100) + 50000) * 100000 + (Math.floor(z / 100) + 50000);
export function setBillboardZones(zones: number[][]) {
  zoneCells.clear();
  for (const p of zones) {
    if (p.length < 6) continue;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); z0 = Math.min(z0, p[i + 1]); z1 = Math.max(z1, p[i + 1]); }
    for (let cx = Math.floor(x0 / 100); cx <= Math.floor(x1 / 100); cx++) for (let cz = Math.floor(z0 / 100); cz <= Math.floor(z1 / 100); cz++) {
      const k = cellOf(cx * 100, cz * 100);
      (zoneCells.get(k) ?? zoneCells.set(k, []).get(k)!).push(p);
    }
  }
}
const inBillboardZone = (x: number, z: number) => zoneCells.get(cellOf(x, z))?.some(p => inZone(p, x, z)) ?? false;
/** low things (grass, bushes, rocks, animals) never hide a billboard */
const LOW = new Set<PropType>(['grass', 'bush', 'rock', 'cow', 'buffalo', 'camel', 'tubewell', 'bund', 'person0', 'person1', 'person2', 'person3', 'goat', 'charpai',
  'stumps', 'saltheap', 'teabush', 'cyclist', 'milestone', 'handpump', 'chabutra', 'scarecrow', 'goalpost', 'clothesline', 'terrace',
  'dog', 'rickshaw', 'cylindercart', 'teastall', 'streetwire', 'person4', 'person5', 'person6', 'person7', 'person8', 'person9', 'person10', 'person11']);

/** Instanced prop types (and the town buildings, buildingKit). Order matters only for stable ids. */
const BASE_TYPES = [
  'mango', 'neem', 'palm', 'forest', 'bush', 'hut', 'house',
  'temple', 'mosque', 'church', 'kiln', 'buffalo', 'cow', 'rock', 'quarter', 'haystack', 'tubewell',
  'hospital', 'school', 'grass', 'treeImp', 'palmImp', 'camel', 'shed', 'warehouse', 'turbine', 'pine', 'pineImp',
  'tiledhouse', 'banana', 'minitower',
  'streetlight', 'scooter', 'autorickshaw', 'handcart', 'watertower', 'clocktower', 'market', 'petrolpump',
  // the scenes between the stations (Scenes.ts)
  'chabutra', 'handpump', 'chaupal', 'charpai', 'clothesline', 'dungcakes', 'tractor', 'bund', 'scarecrow',
  'person0', 'person1', 'person2', 'person3', 'bullockcart', 'bricks', 'dhaba', 'truckpainted', 'milestone',
  'paintedtrunk', 'pylon', 'wirespan', 'mobiletower', 'factory', 'goalpost', 'stumps', 'goat', 'cyclist',
  'solarpanel', 'fortwall', 'chhatri', 'stepwell', 'terrace', 'teabush', 'woodstack', 'saltheap',
  'teastall', 'rickshaw', 'dog', 'tanker', 'cylindercart', 'wallad', 'streetwire', 'tyreshop', 'warntriangle', 'branches', 'stringlights',
  // drawn from the life texture packs (lifeKit): people in their clothes, shop kiosks, painted walls
  'person4', 'person5', 'person6', 'person7', 'person8', 'person9', 'person10', 'person11',
  'shop0', 'shop1', 'shop2', 'shop3', 'shop4', 'shop5', 'shop6', 'shop7',
  'wallpaint0', 'wallpaint1', 'wallpaint2', 'wallpaint3', 'wallpaint4', 'wallpaint5', 'wallpaint6', 'wallpaint7',
] as const;
export type PropType = typeof BASE_TYPES[number] | BuildingType;
export const PROP_TYPES: PropType[] = [...BASE_TYPES, ...BUILDING_TYPES];
export const PROP_STRIDE = 10; // x y z ry sx sy sz r g b

/** Per-vertex info grid computed with the terrain heights, reused for placement. */
export interface TileInfo {
  x0: number; z0: number; size: number; res: number;
  h: Float32Array; dist: Float32Array; km: Float32Array; d: Float32Array; heading: Float32Array;
  road: Float32Array; water: Uint8Array; slope: Float32Array;
}

/**
 * Half footprints (x, z, template metres before scale) of the props that are
 * buildings. Each one sits on the highest ground under its four corners; its
 * template has a plinth reaching PLINTH_DEPTH below its base, so on a slope the low side
 * shows foundation, never a wall sunk into the ground.
 */
export const FOOTPRINT: Partial<Record<PropType, [number, number]>> = {
  shed: [9.1, 6.1], warehouse: [24.1, 12.1],
  hospital: [21.2, 7.2], school: [16.2, 5.7],
  house: [3.7, 3.2], hut: [2.1, 1.8], tiledhouse: [4.7, 5.6], minitower: [5.2, 3.7], quarter: [6.6, 3.6], temple: [4.1, 4.1], mosque: [7.3, 5.1], church: [4.1, 11.1], kiln: [17.1, 10.1],
  watertower: [4.6, 4.6], clocktower: [2.6, 2.6], market: [9.5, 4.5], petrolpump: [9.5, 7], tyreshop: [4.6, 3.1],
  shop0: [1.9, 1.6], shop1: [1.9, 1.6], shop2: [1.9, 1.6], shop3: [1.9, 1.6], shop4: [1.9, 1.6], shop5: [1.9, 1.6], shop6: [1.9, 1.6], shop7: [1.9, 1.6],
  dhaba: [5.3, 4.2], factory: [12.2, 9.2], chaupal: [2.1, 1.7], chhatri: [2.4, 2.4], stepwell: [6.5, 6.5], chabutra: [3.6, 3.6],
  ...Object.fromEntries(BUILDING_TYPES.map(t => { const [, s, c, v] = t.split('-'); return [t, buildingFootprint(s as BuildingStyle, +c, +v)]; })),
};
/** plinth depth below the template base (m); also the steepest footprint a building is put on */
export const PLINTH_DEPTH = 2.5;

class Out {
  lists = new Map<PropType, number[]>();
  constructor(private ground: (x: number, z: number) => number) {}
  push(t: PropType, x: number, y: number, z: number, ry: number, sx: number, sy: number, sz: number, c: [number, number, number]) {
    if (!LOW.has(t) && inBillboardZone(x, z)) return NaN;
    const fp = FOOTPRINT[t];
    if (fp) {
      // corners of the rotated, scaled footprint on the rendered terrain
      const cs = Math.cos(ry), sn = Math.sin(ry);
      let lo = Infinity, hi = -Infinity;
      for (const [u, v] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const lx = u * fp[0] * sx, lz = v * fp[1] * sz;
        const h = this.ground(x + lx * cs + lz * sn, z - lx * sn + lz * cs);
        lo = Math.min(lo, h); hi = Math.max(hi, h);
      }
      if (hi - lo > PLINTH_DEPTH - 0.2) return NaN; // too steep for this building
      y = hi;
    }
    let l = this.lists.get(t);
    if (!l) this.lists.set(t, (l = []));
    l.push(x, y, z, ry, sx, sy, sz, c[0], c[1], c[2]);
    return y;
  }
}

const tint = (r: () => number, base: [number, number, number], v = 0.15): [number, number, number] => {
  const k = 1 - v + r() * v * 2;
  return [base[0] * k, base[1] * k, base[2] * k];
};
/** the coastal south's colour-washed walls: ochre, sea green, sky blue, pink, lime, white */
const SOUTH: [number, number, number][] = [[0.98, 0.82, 0.5], [0.62, 0.86, 0.78], [0.66, 0.8, 0.95], [0.96, 0.72, 0.76], [0.82, 0.92, 0.55], [0.96, 0.95, 0.92]];
const PASTELS: [number, number, number][] = [[0.95, 0.9, 0.78], [0.86, 0.9, 0.95], [0.98, 0.85, 0.72], [0.82, 0.93, 0.82], [0.96, 0.8, 0.82], [0.92, 0.92, 0.9], [0.98, 0.95, 0.62]];

/** the shopfront pack is in: one-room shops can line the streets */
const SHOPS_ON = lifeCells('life/solid-pack', 'shopfronts').length > 0;

/** Building paint: a near-white tint (the facade's own colours show), a little warmer or cooler per building. */
const paint = (r: () => number): [number, number, number] => { const k = 0.9 + r() * 0.12, w = (r() - 0.5) * 0.06; return [k * (1 + w), k, k * (1 - w)]; };
const VEHICLE: [number, number, number][] = [[0.75, 0.1, 0.1], [0.15, 0.3, 0.7], [0.9, 0.9, 0.9], [0.2, 0.2, 0.22], [0.15, 0.55, 0.3], [0.95, 0.75, 0.2]];

/** the atlas cells each style picks from: street fronts (shops among houses), houses back from the road, one-storey village houses */
const POOLS = Object.fromEntries(STYLES.map(st => [st, {
  street: cellsOf(st, st === 'city' ? ['tower'] : ['shop', 'shop', 'house', 'construction']),
  houses: cellsOf(st, st === 'city' ? ['tower'] : ['house', 'house', 'construction']),
  small: cellsOf(st, ['house', 'shop'], 6.5),
}])) as Record<BuildingStyle, { street: number[]; houses: number[]; small: number[] }>;

/** The building style at km: the region's; blocks of flats and offices (city) mixed in near a junction. */
function townStyle(route: Route, km: number, r: () => number): BuildingStyle {
  const big = route.stations.some(st => st.type === 'junction' && Math.abs(st.km - km) < CITY_KM);
  const city = r() < 0.65;
  return big && city ? 'city' : styleOfRegion(route.regionIdAt(km));
}

/**
 * Which way a building at (km, lateral d) faces (its yaw; a building's front is its local +z): near a station
 * (400 m) toward the line and the station, so arriving trains see fronts; in a town with a road alongside, toward
 * that road (from either side of it); else toward the line, the lane every railside settlement grows along.
 */
export function facing(route: Route, km: number, d: number, heading: number) {
  const toLine = -heading + (d > 0 ? Math.PI : 0);
  if (route.stations.some(st => st.type !== 'halt' && Math.abs(st.km - km) < 0.4)) return toLine;
  const ro = roadAt(route, km, d)?.offsetAt(km);
  if (ro && Math.sign(ro) === Math.sign(d)) {
    // (between the line and the road: toward the road, i.e. away from the line; beyond it: back toward it)
    const outward = Math.abs(d) < Math.abs(ro);
    return -heading + ((ro > 0) === outward ? 0 : Math.PI);
  }
  return toLine;
}

/** Deterministic RNG for one candidate cell: the same cell always gives the same props, at any LOD. */
const cellRng = (ix: number, iz: number, layer: number) => rng(Math.floor(hash2(ix, iz, layer) * 4294967296));

export function placeScenery(field: TerrainField, route: Route, info: TileInfo, level: 'full' | 'impostor', grassDensity: number) {
  const { x0, z0, size, res } = info;
  const cellM = size / res;
  const at = (x: number, z: number) => {
    const i = Math.min(res, Math.max(0, Math.round((x - x0) / cellM)));
    const j = Math.min(res, Math.max(0, Math.round((z - z0) / cellM)));
    return j * (res + 1) + i;
  };
  // height on the exact triangle the terrain mesh renders (split along b-c, see terrain.worker)
  // so props never float or sink, at any LOD
  const hAt = (x: number, z: number) => {
    const fx = Math.min(res - 1e-6, Math.max(0, (x - x0) / cellM)), fz = Math.min(res - 1e-6, Math.max(0, (z - z0) / cellM));
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j, W = res + 1;
    const a = info.h[j * W + i], b = info.h[j * W + i + 1], c = info.h[(j + 1) * W + i], d = info.h[(j + 1) * W + i + 1];
    return tx + tz <= 1 ? a + (b - a) * tx + (c - a) * tz : d + (c - d) * (1 - tx) + (b - d) * (1 - tz);
  };
  const out = new Out(hAt);
  const step = 8;
  let rand = cellRng(0, 0, 0);
  const tree = (x: number, y: number, z: number, g: number, near: boolean, rand: () => number) => {
    const reg = route.regionAt(field.kmAt(x, z));
    const t = reg.treeTypes[Math.floor(rand() * reg.treeTypes.length)] as PropType;
    const s = 0.75 + rand() * 0.6;
    if (t === 'pine') {
      // conifers: dark needles; a cone far away
      if (level === 'impostor' || !near) out.push('pineImp', x, y, z, rand() * 6.28, s, s * (0.9 + rand() * 0.4), s, tint(rand, [1, 1, 1], 0.15));
      else out.push('pine', x, y, z, rand() * 6.28, s, s * (0.9 + rand() * 0.4), s, tint(rand, [0.5, 0.66, 0.55], 0.12));
      return;
    }
    if (level === 'impostor' || !near) out.push(t === 'palm' ? 'palmImp' : 'treeImp', x, y, z, rand() * 6.28, s * (t === 'forest' ? 1.3 : 1), s * (t === 'forest' ? 1.5 : 1), s, tint(rand, g > 0.5 ? [0.75, 0.9, 0.7] : [0.95, 1, 0.85], 0.2));
    else out.push(t, x, y, z, rand() * 6.28, s, s, s, tint(rand, [1, 1, 1], 0.18));
  };

  for (let gz = z0 + step / 2; gz < z0 + size; gz += step) {
    for (let gx = x0 + step / 2; gx < x0 + size; gx += step) {
      const ix = Math.round((gx - step / 2) / step), iz = Math.round((gz - step / 2) / step);
      rand = cellRng(ix, iz, 1);
      const x = gx + (rand() - 0.5) * step * 0.9, z = gz + (rand() - 0.5) * step * 0.9;
      const k = at(x, z);
      if (info.water[k]) continue;
      const dist = info.dist[k];
      const km = info.km[k];
      if (info.road[k] < 7) continue;
      const W = dist < 300 ? route.formationHalfWidth(km) : 0;
      // the track corridor stays clear - except over a tunnel, where trees and grass cover the hill
      if ((dist < W + 7 || dist < 13 + route.halfSpacing) && !route.overTunnel(km)) continue;
      const reg = route.regionAt(km), biome = biomeOf(reg);
      const g = biome === 'ghats' ? 1 : 0;
      const far = biome === 'ghats' ? 'ghats' : biome === 'desert' ? 'desert' : biome === 'hills' ? 'hills' : biome === 'coast' ? 'coast' : biome === 'snow' ? 'snow' : 'fields';
      // snow country is snow country whatever the route's zones say (only towns and colonies keep their own)
      const zone0 = dist < 1800 ? route.zoneAt(km).zone : far;
      const zone = biome === 'snow' && zone0 !== 'town' && zone0 !== 'colony' && zone0 !== 'village' ? 'snow' : zone0;
      const y = hAt(x, z);
      const slope = info.slope[k];
      const r = rand();
      const heading = info.heading[k];
      const near = level === 'full';

      if (grassDensity > 0 && near && dist < 70) {
        // separate stream so grass never changes the other props
        const gr = cellRng(ix, iz, 2);
        const n = Math.floor(grassDensity * 1.2 + gr());
        for (let q = 0; q < n; q++) {
          const qx = gx + (gr() - 0.5) * step, qz = gz + (gr() - 0.5) * step;
          if (Math.hypot(qx - x, qz - z) < 0.5) continue;
          // desert grass is sparse and straw-coloured
          if (biome === 'desert' && gr() < 0.7) continue;
          out.push('grass', qx, hAt(qx, qz), qz, gr() * 6.28, 1, 0.7 + gr() * 0.6, 1, tint(gr, g > 0.5 ? [0.8, 1, 0.75] : biome === 'desert' ? [1.25, 1.05, 0.7] : [1, 0.95, 0.75]));
        }
      }

      if (slope > 0.75) { if (r < 0.04 && near) out.push('rock', x, y - 0.3, z, rand() * 6.28, 1 + rand() * 2, 0.8 + rand(), 1 + rand() * 2, tint(rand, [0.62, 0.6, 0.56])); continue; }

      if (zone === 'town') {
        // the road's frontage is placeStreets' rows; back from it, houses in the region's style (each a different
        // facade, paint and roof), blocks of flats near a junction
        if (info.road[k] > 24 && dist > 22 + route.halfSpacing && r < 0.17 && dist < 600) {
          if (level === 'impostor' && rand() < 0.5) continue;
          const style = townStyle(route, km, rand), pool = POOLS[style].houses;
          const cell = pool[Math.floor(rand() * pool.length)], v = rand() < 0.5 ? 0 : 1;
          rand(); // (kept: the old random quarter turn's draw, so the rest of the town stays where it was)
          out.push(buildingType(style, cell, v), x, y, z, facing(route, km, info.d[k], heading), 1, 1, 1, paint(rand));
          continue;
        }
        if (near && r > 0.997) { const t: PropType = rand() < 0.5 ? 'temple' : rand() < 0.6 ? 'mosque' : 'church'; out.push(t, x, y, z, -heading, 1, 1, 1, [1, 1, 1]); continue; }
        if (r > 0.94) tree(x, y, z, g, near, rand);
        continue;
      }

      // coastal South Indian town: low tiled-roof houses with verandas, coconut palms and banana plants, a temple-style tower far off
      if (zone === 'south-town') {
        if (dist > 22 + route.halfSpacing && r < 0.2 && dist < 650) {
          if (level === 'impostor' && rand() < 0.5) continue;
          rand(); rand();
          out.push('tiledhouse', x, y, z, facing(route, km, info.d[k], heading), 0.9 + rand() * 0.25, 0.9 + rand() * 0.3, 0.9 + rand() * 0.25, SOUTH[Math.floor(rand() * SOUTH.length)]);
          continue;
        }
        if (dist > 320 && r > 0.9975) { out.push('minitower', x, y, z, -heading, 1, 1, 1, [1, 1, 1]); continue; }
        if (r > 0.88) {
          const s = 0.8 + rand() * 0.5;
          if (level === 'impostor' || !near) out.push('palmImp', x, y, z, rand() * 6.28, s, s, s, tint(rand, [0.95, 1, 0.85], 0.2));
          else out.push('palm', x, y, z, rand() * 6.28, s, s, s, tint(rand, [1, 1, 1], 0.18));
          continue;
        }
        if (near && r > 0.84) out.push('banana', x, y, z, rand() * 6.28, 0.9, 0.8 + rand() * 0.5, 0.9, tint(rand, [1, 1, 1], 0.15));
        continue;
      }

      if (zone === 'colony') { if (r > 0.95) tree(x, y, z, g, near, rand); continue; }

      if (zone === 'ghats') {
        if (r < reg.treeDensity * 0.55) tree(x, y, z, g, near, rand);
        else if (near && r < reg.treeDensity * 0.7) out.push('bush', x, y, z, rand() * 6.28, 1, 0.8 + rand() * 0.5, 1, tint(rand, [0.8, 0.95, 0.75]));
        continue;
      }

      // snow: pine forest in bands and clumps up the slopes, open snowfields and boulders between
      if (zone === 'snow') {
        const forest = hash2(Math.floor(x / 160), Math.floor(z / 160), 97) < 0.5 || hash2(Math.floor(x / 60), Math.floor(z / 60), 98) < 0.18;
        if (forest ? r < reg.treeDensity * 0.9 : r < reg.treeDensity * 0.05) { tree(x, y, z, g, near, rand); continue; }
        if (near && r > 0.993) out.push('rock', x, y - 0.4, z, rand() * 6.28, 1 + rand() * 2, 0.8 + rand(), 1 + rand() * 2, tint(rand, [0.62, 0.62, 0.66]));
        continue;
      }

      // desert: dunes with scattered scrub and lone trees, camel herds, the odd hamlet (dhani)
      if (zone === 'desert') {
        if (r < reg.treeDensity * 0.08) { tree(x, y, z, g, near, rand); continue; }
        if (near && r < reg.treeDensity * 0.3) { out.push('bush', x, y, z, rand() * 6.28, 0.7 + rand() * 0.4, 0.5 + rand() * 0.4, 0.7 + rand() * 0.4, tint(rand, [0.85, 0.85, 0.6], 0.2)); continue; }
        const hc = hash2(Math.floor(x / 400), Math.floor(z / 400), 81);
        if (near && hc < 0.12 && dist > 60 && r > 0.985) { out.push('camel', x, y, z, rand() * 6.28, 1, 1, 1, tint(rand, [0.85, 0.7, 0.5], 0.1)); continue; }
        if (hc > 0.93 && dist > 120 && r > 0.96) { out.push('hut', x, y, z, rand() * 6.28, 0.8, 0.9, 0.8, tint(rand, [1.1, 0.95, 0.8])); continue; }
        if (near && slope > 0.3 && r > 0.995) out.push('rock', x, y - 0.3, z, rand() * 6.28, 1, 0.6, 1.2, tint(rand, [0.8, 0.65, 0.5]));
        continue;
      }

      // rocky hills: thorn scrub and boulders, a few trees in the folds
      if (zone === 'hills') {
        if (r < reg.treeDensity * 0.3) { tree(x, y, z, g, near, rand); continue; }
        if (near && r < reg.treeDensity * 0.8) { out.push('bush', x, y, z, rand() * 6.28, 0.8 + rand() * 0.4, 0.6 + rand() * 0.5, 0.8 + rand() * 0.4, tint(rand, [0.7, 0.8, 0.55], 0.2)); continue; }
        if (near && r > 0.985) out.push('rock', x, y - 0.4, z, rand() * 6.28, 1 + rand() * 2.5, 0.8 + rand() * 1.2, 1 + rand() * 2.5, tint(rand, [0.75, 0.62, 0.52]));
        continue;
      }

      // coast: salt pans and scrub with coconut palms
      if (zone === 'coast') {
        if (r < reg.treeDensity * 0.2) { tree(x, y, z, g, near, rand); continue; }
        if (near && r < reg.treeDensity * 0.35) out.push('bush', x, y, z, rand() * 6.28, 0.8, 0.6, 0.8, tint(rand, [0.75, 0.85, 0.6]));
        continue;
      }

      // freight belt: sheds and warehouses near the line, trucks' yards (bare ground)
      if (zone === 'industrial') {
        if (dist > 40 + route.halfSpacing && dist < 420 && r < 0.022) {
          const t: PropType = rand() < 0.4 ? 'warehouse' : 'shed';
          out.push(t, x, y, z, -heading + (rand() < 0.5 ? 0 : Math.PI / 2), 1, 1, 1, tint(rand, [0.85, 0.87, 0.88], 0.1));
          continue;
        }
        if (r > 0.97) tree(x, y, z, g, near, rand);
        continue;
      }
      if (zone === 'terminal') continue; // container yards are built by FreightYards

      // fields / village / river plains
      const vcx = Math.floor(x / 300), vcz = Math.floor(z / 300);
      let village = false, vx = 0, vz = 0;
      for (let i = -1; i <= 1 && !village; i++) for (let j = -1; j <= 1 && !village; j++) {
        const cx = vcx + i, cz = vcz + j;
        const chance = reg.villagesPerKm2 * 0.09 * (zone === 'village' ? 4 : 1);
        if (hash2(cx, cz, 61) > chance) continue;
        vx = (cx + hash2(cx, cz, 62)) * 300; vz = (cz + hash2(cx, cz, 63)) * 300;
        if (Math.hypot(x - vx, z - vz) < 75) village = true;
      }
      if (village) {
        // (houses and huts face the village's middle: its square and big tree)
        const inward = Math.atan2(vx - x, vz - z) + (rand() - 0.5) * 0.3;
        if (r < 0.3) { out.push('hut', x, y, z, inward, 0.8 + rand() * 0.4, 0.9 + rand() * 0.2, 0.8 + rand() * 0.4, tint(rand, [1, 0.95, 0.88])); continue; }
        if (near && r < 0.34) {
          // a village house in the region's style (one storey), else the plain one
          const pool = POOLS[styleOfRegion(route.regionIdAt(km))].small, sty = styleOfRegion(route.regionIdAt(km));
          if (pool.length) out.push(buildingType(sty, pool[Math.floor(rand() * pool.length)], rand() < 0.5 ? 0 : 1), x, y, z, inward, 1, 1, 1, paint(rand));
          else out.push('house', x, y, z, inward, 1, 1, 1, PASTELS[Math.floor(rand() * PASTELS.length)]);
          continue;
        }
        if (near && r < 0.37) { out.push('haystack', x, y, z, 0, 0.8 + rand() * 0.5, 0.8 + rand() * 0.5, 0.8 + rand() * 0.5, tint(rand, [1, 1, 1])); continue; }
        if (near && r < 0.39) { out.push('buffalo', x, y, z, rand() * 6.28, 1, 1, 1, tint(rand, [1, 1, 1], 0.1)); continue; }
        if (r < 0.5) { tree(x, y, z, g, near, rand); continue; }
        continue;
      }
      if (r < reg.treeDensity * 0.09) { tree(x, y, z, g, near, rand); continue; }
      if (!near) continue;
      if (r > 0.9985) { out.push('tubewell', x, y, z, rand() * 6.28, 1, 1, 1, [1, 1, 1]); continue; }
      if (dist > 14 + route.halfSpacing && dist < 45 && r > 0.996) { out.push(rand() < 0.6 ? 'cow' : 'buffalo', x, y, z, rand() * 6.28, 1, 1, 1, tint(rand, [1, 1, 1], 0.1)); continue; }
      if (r > 0.993 && r < 0.996) { out.push('haystack', x, y, z, 0, 1, 1, 1, [1, 1, 1]); continue; }
    }
  }

  if (level === 'full') {
    // brick kilns: one candidate per 1 km cell
    const k0x = Math.floor(x0 / 1000), k0z = Math.floor(z0 / 1000);
    for (let i = 0; i <= 1; i++) for (let j = 0; j <= 1; j++) {
      const cx = k0x + i, cz = k0z + j;
      const x = (cx + 0.2 + hash2(cx, cz, 71) * 0.6) * 1000, z = (cz + 0.2 + hash2(cx, cz, 72) * 0.6) * 1000;
      if (x < x0 || x >= x0 + size || z < z0 || z >= z0 + size) continue;
      const k = at(x, z);
      const reg = route.regionAt(info.km[k]);
      if (hash2(cx, cz, 73) > reg.kilnsPerKm2 || info.dist[k] < 150 || info.water[k] || info.road[k] < 40) continue;
      out.push('kiln', x, hAt(x, z), z, hash2(cx, cz, 74) * 6.28, 1, 1, 1, [1, 1, 1]);
    }
    placeColony(route, info, out, hAt);
    placeStreets(route, info, out, hAt);
    // wind farms on the ridges and dunes of windy regions: one candidate per 600 m cell
    const t0x = Math.floor(x0 / 600), t0z = Math.floor(z0 / 600);
    for (let i = 0; i <= 1; i++) for (let j = 0; j <= 1; j++) {
      const cx = t0x + i, cz = t0z + j;
      const x = (cx + 0.25 + hash2(cx, cz, 91) * 0.5) * 600, z = (cz + 0.25 + hash2(cx, cz, 92) * 0.5) * 600;
      if (x < x0 || x >= x0 + size || z < z0 || z >= z0 + size) continue;
      const k = at(x, z);
      const reg = route.regionAt(info.km[k]);
      if (hash2(cx, cz, 93) > (reg.windTurbinesPerKm2 ?? 0) * 0.36 || info.dist[k] < 260 || info.water[k] || info.road[k] < 40) continue;
      out.push('turbine', x, hAt(x, z), z, 0.6 + hash2(cx, cz, 94) * 0.3, 1, 1, 1, [1, 1, 1]);
    }
  }
  // the scenes between the stations (far tiles too: their villages, groves and towers make the skyline)
  placeScenes(route, x0, z0, size, {
    route, full: level === 'full', detail: grassDensity > 0,
    put: (t, x, z, ry, sx, sy, sz, c) => { out.push(t, x, hAt(x, z), z, ry, sx, sy, sz, c); },
    water: (x, z) => !!info.water[at(x, z)], road: (x, z) => info.road[at(x, z)],
  });

  const result: Partial<Record<PropType, Float32Array>> = {};
  for (const [t, l] of out.lists) result[t] = new Float32Array(l);
  return result;
}

/**
 * Town streets (town zones with a road alongside the line): shop-houses in rows along both sides of the road,
 * facing it, nearly touching, a lane now and then; parked scooters, autos and handcarts and the odd cow in
 * front, street lights along it; a few landmarks behind the far row (a water tower, a clock tower, a market,
 * a petrol pump). Laid out along the line from the zone's start, with every random draw made whether or not
 * the thing lands in this tile, so every tile sees the same town. Open in front of the station building
 * (its forecourt), at level crossings and by bridges.
 */
function placeStreets(route: Route, info: TileInfo, out: Out, hAt: (x: number, z: number) => number) {
  const f = newFrame();
  const inside = (x: number, z: number) => x >= info.x0 && x < info.x0 + info.size && z >= info.z0 && z < info.z0 + info.size;
  let kmLo = Infinity, kmHi = -Infinity;
  for (let i = 0; i < info.km.length; i += 7) if (info.dist[i] < 400) { kmLo = Math.min(kmLo, info.km[i]); kmHi = Math.max(kmHi, info.km[i]); }
  const put = (t: PropType, s: number, lat: number, ry: (h: number) => number, c: [number, number, number]) => {
    route.alignment.sampleOffset(s, lat, f);
    if (inside(f.x, f.z)) out.push(t, f.x, hAt(f.x, f.z), f.z, ry(f.heading), 1, 1, 1, c);
  };
  const lcs = route.data.levelCrossings.map(l => l.km);
  for (const zn of route.data.scenery) {
    if (zn.zone !== 'town' || !zn.roadOffset || zn.toKm < kmLo - 0.15 || zn.fromKm > kmHi + 0.15) continue;
    const ro = zn.roadOffset, side = Math.sign(ro);
    const open = (km: number, face: number) => lcs.some(l => Math.abs(l - km) < 0.05) || !!route.structureAt(km)
      || (face < 0 && route.stations.some(st => st.buildingSide === side && Math.abs(st.km - km) < 0.045));
    for (const face of [-1, 1] as const) {
      // (the row between the line and the road faces out toward the road; the row beyond it faces back)
      const facesOut = (face < 0) === (side > 0);
      const r = rng(Math.floor(hash2(Math.round(zn.fromKm * 1000), face, 517) * 4294967296));
      for (let s = zn.fromKm * 1000 + 30; s < zn.toKm * 1000 - 30;) {
        const u = Array.from({ length: 12 }, r);
        const km = s / 1000, style = townStyle(route, km, () => u[0]), pool = POOLS[style].street;
        const cell = pool[Math.floor(u[1] * pool.length)], v = u[2] < 0.5 ? 0 : 1, L = buildingLayout(style, cell, v);
        // near a station a run of one-room shops now and then (the shopfront pack: tea, sweets, cloth, hardware...)
        const kiosk = SHOPS_ON && u[11] > 0.7 && route.stations.some(st => st.type !== 'halt' && Math.abs(st.km - km) < 0.6);
        if (kiosk && !open(km, face)) {
          for (let k = 0; k < 3; k++) put(`shop${Math.floor(((u[1] + k * 0.37) % 1) * SHOP_VARIANTS)}` as PropType, s + 2 + k * 3.8, ro + face * side * 6.6, h => -h + (facesOut ? 0 : Math.PI), [1, 1, 1]);
          s += 12;
          continue;
        }
        const wd = Math.max(L.w, L.bx1 - L.bx0);
        if (!open(km, face)) {
          // (the line's side of the road, near a station: toward the station instead, its fronts to arriving trains)
          const lat = ro + face * side * (5 + L.d / 2), nearSt = face < 0 && route.stations.some(st => st.type !== 'halt' && Math.abs(st.km - km) < 0.4);
          put(buildingType(style, cell, v), s + wd / 2, lat, h => (nearSt ? -h + (lat > 0 ? Math.PI : 0) : -h + (facesOut ? 0 : Math.PI)), paint(() => u[3]));
          // out front, by the road: scooters, fruit carts, autos, cycle rickshaws, a gas cylinder cart, a tea stall by a
          // shop; a stray dog or a cow in the road now and then
          const front: PropType[] = ['scooter', 'scooter', 'handcart', 'autorickshaw', 'rickshaw', 'cylindercart', L.kind === 'shop' ? 'teastall' : 'scooter', 'tanker'];
          if (u[4] < 0.5) put(front[Math.floor(u[5] * front.length)], s + wd * u[6], ro + face * side * 3.4, h => -h + (u[7] < 0.5 ? 0 : Math.PI), VEHICLE[Math.floor(u[8] * VEHICLE.length)]);
          if (u[9] < 0.03) put('cow', s + wd * u[6], ro + (u[7] - 0.5) * 3, h => h * u[10] * 6, [0.95, 0.93, 0.9]);
          else if (u[9] < 0.08) put('dog', s + wd * (1 - u[6]), ro + face * side * (2 + u[7]), h => h + u[10] * 6, [0.75 + u[3] * 0.2, 0.6 + u[3] * 0.2, 0.45]);
        }
        s += wd + (u[11] < 0.12 ? 4 + u[10] * 6 : 0.25);
      }
    }
    // street lights on the line's side of the road, arms over it
    for (let s = zn.fromKm * 1000 + 20; s < zn.toKm * 1000 - 20; s += 32) if (!open(s / 1000, 1)) {
      put('streetlight', s, ro - side * 4.2, h => -h - side * Math.PI / 2, [1, 1, 1]);
      // the wires to the next pole, every which way
      if (s + 32 < zn.toKm * 1000 - 20 && !open((s + 32) / 1000, 1)) { route.alignment.sampleOffset(s, ro - side * 4.2, f); if (inside(f.x, f.z)) out.push('streetwire', f.x, hAt(f.x, f.z), f.z, -f.heading, 32, 1, 1, [1, 1, 1]); }
    }
    // landmarks behind the far row (the same few for the same town)
    const lr = rng(Math.floor(hash2(Math.round(zn.fromKm * 1000), 7, 521) * 4294967296));
    const kinds: PropType[] = ['watertower', 'clocktower', 'market', 'petrolpump', 'school'];
    for (const frac of [0.3, 0.62, 0.86]) {
      const t = kinds.splice(Math.floor(lr() * kinds.length), 1)[0], km = zn.fromKm + (zn.toKm - zn.fromKm) * frac;
      if (!open(km, 1)) put(t, km * 1000, ro + side * (t === 'petrolpump' ? 16 : 34), h => -h + (side > 0 ? Math.PI : 0), [1, 1, 1]);
    }
  }
}

/** Railway colony: regular rows of quarters, a hospital and a school, laid out in track coordinates. */
function placeColony(route: Route, info: TileInfo, out: Out, hAt: (x: number, z: number) => number) {
  const f = newFrame();
  const inside = (x: number, z: number) => x >= info.x0 && x < info.x0 + info.size && z >= info.z0 && z < info.z0 + info.size;
  for (const zn of route.data.scenery) {
    if (zn.zone !== 'colony') continue;
    const side = Math.sign(zn.roadOffset ?? -1) || -1;
    const put = (t: PropType, km: number, d: number, c: [number, number, number]) => {
      route.alignment.sampleOffset(km * 1000, d, f);
      if (inside(f.x, f.z)) out.push(t, f.x, hAt(f.x, f.z) - 0.2, f.z, -f.heading, 1, 1, 1, c);
    };
    for (let km = zn.fromKm + 0.08; km < zn.toKm - 0.08; km += 0.026) {
      for (let row = 0; row < 4; row++) put('quarter', km, side * (72 + row * 24), [0.96, 0.9, 0.72]);
    }
    put('hospital', zn.fromKm + 0.35, side * 205, [0.97, 0.97, 0.97]);
    put('school', zn.toKm - 0.4, side * 200, [0.98, 0.88, 0.55]);
  }
}
