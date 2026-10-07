import { hash2, rng } from '@rail/shared/util';
import { newFrame } from '@rail/shared/track/Chainage';
import type { Route } from '@rail/shared/track/Route';
import type { TerrainField } from '../TerrainField';

/** Instanced prop types. Order matters only for stable ids. */
export const PROP_TYPES = [
  'mango', 'neem', 'palm', 'forest', 'bush', 'hut', 'house', 'building2', 'building4', 'building7', 'tank',
  'temple', 'mosque', 'church', 'kiln', 'buffalo', 'cow', 'rock', 'billboard', 'quarter', 'haystack', 'tubewell',
  'hospital', 'school', 'grass', 'treeImp', 'palmImp',
] as const;
export type PropType = typeof PROP_TYPES[number];
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
  building2: [6.2, 5.2], building4: [6.2, 5.2], building7: [6.2, 5.2], hospital: [21.2, 7.2], school: [16.2, 5.7],
  house: [3.7, 3.2], hut: [2.1, 1.8], quarter: [6.6, 3.6], temple: [4.1, 4.1], mosque: [7.3, 5.1], church: [4.1, 11.1], kiln: [17.1, 10.1],
};
/** plinth depth below the template base (m); also the steepest footprint a building is put on */
export const PLINTH_DEPTH = 2.5;

class Out {
  lists = new Map<PropType, number[]>();
  constructor(private ground: (x: number, z: number) => number) {}
  push(t: PropType, x: number, y: number, z: number, ry: number, sx: number, sy: number, sz: number, c: [number, number, number]) {
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
const PASTELS: [number, number, number][] = [[0.95, 0.9, 0.78], [0.86, 0.9, 0.95], [0.98, 0.85, 0.72], [0.82, 0.93, 0.82], [0.96, 0.8, 0.82], [0.92, 0.92, 0.9], [0.98, 0.95, 0.62]];

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
  const plains = Object.values(route.regions).find(r => r.sideSlope === 0)!;
  const ghats = Object.values(route.regions).find(r => r.sideSlope > 0) ?? plains;

  const tree = (x: number, y: number, z: number, g: number, near: boolean, rand: () => number) => {
    const reg = g > 0.5 ? ghats : plains;
    const t = reg.treeTypes[Math.floor(rand() * reg.treeTypes.length)] as PropType;
    const s = 0.75 + rand() * 0.6;
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
      const g = field.ghatAt(km);
      const zone = dist < 1800 ? route.zoneAt(km).zone : g > 0.5 ? 'ghats' : 'fields';
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
          out.push('grass', qx, hAt(qx, qz), qz, gr() * 6.28, 1, 0.7 + gr() * 0.6, 1, tint(gr, g > 0.5 ? [0.8, 1, 0.75] : [1, 0.95, 0.75]));
        }
      }

      if (slope > 0.75) { if (r < 0.04 && near) out.push('rock', x, y - 0.3, z, rand() * 6.28, 1 + rand() * 2, 0.8 + rand(), 1 + rand() * 2, tint(rand, [0.62, 0.6, 0.56])); continue; }

      if (zone === 'town') {
        const roadNear = info.road[k] < 30;
        if (dist > 22 + route.halfSpacing && r < (roadNear ? 0.3 : 0.16) && dist < 600) {
          if (level === 'impostor' && rand() < 0.5) continue;
          const sel = rand();
          const t: PropType = sel < 0.45 ? 'building2' : sel < 0.85 ? 'building4' : 'building7';
          const floors = t === 'building2' ? 2 : t === 'building4' ? 4 : 7;
          const s = 0.85 + rand() * 0.3;
          const ry = -heading + (rand() < 0.5 ? 0 : Math.PI / 2);
          const by = out.push(t, x, y, z, ry, s, 1, s, PASTELS[Math.floor(rand() * PASTELS.length)]);
          if (near && rand() < 0.6 && !Number.isNaN(by)) out.push('tank', x + (rand() - 0.5) * 6, by + floors * 3.1 + 0.6, z + (rand() - 0.5) * 5, 0, 1, 1, 1, [0.12, 0.12, 0.13]);
          continue;
        }
        if (near && r > 0.997) { const t: PropType = rand() < 0.5 ? 'temple' : rand() < 0.6 ? 'mosque' : 'church'; out.push(t, x, y, z, -heading, 1, 1, 1, [1, 1, 1]); continue; }
        if (near && dist > 18 + route.halfSpacing && dist < 45 && r > 0.985) { out.push('billboard', x, y, z, -heading - Math.PI / 2 * Math.sign(info.d[k]), 1, 1, 1, [1, 1, 1]); continue; }
        if (r > 0.94) tree(x, y, z, g, near, rand);
        continue;
      }

      if (zone === 'colony') { if (r > 0.95) tree(x, y, z, g, near, rand); continue; }

      if (zone === 'ghats') {
        if (r < ghats.treeDensity * 0.55) tree(x, y, z, g, near, rand);
        else if (near && r < ghats.treeDensity * 0.7) out.push('bush', x, y, z, rand() * 6.28, 1, 0.8 + rand() * 0.5, 1, tint(rand, [0.8, 0.95, 0.75]));
        continue;
      }

      // fields / village / river plains
      const vcx = Math.floor(x / 300), vcz = Math.floor(z / 300);
      let village = false;
      for (let i = -1; i <= 1 && !village; i++) for (let j = -1; j <= 1 && !village; j++) {
        const cx = vcx + i, cz = vcz + j;
        const chance = (g > 0.5 ? ghats : plains).villagesPerKm2 * 0.09 * (zone === 'village' ? 4 : 1);
        if (hash2(cx, cz, 61) > chance) continue;
        const vx = (cx + hash2(cx, cz, 62)) * 300, vz = (cz + hash2(cx, cz, 63)) * 300;
        if (Math.hypot(x - vx, z - vz) < 75) village = true;
      }
      if (village) {
        if (r < 0.3) { out.push('hut', x, y, z, rand() * 6.28, 0.8 + rand() * 0.4, 0.9 + rand() * 0.2, 0.8 + rand() * 0.4, tint(rand, [1, 0.95, 0.88])); continue; }
        if (near && r < 0.34) { out.push('house', x, y, z, rand() * 6.28, 1, 1, 1, PASTELS[Math.floor(rand() * PASTELS.length)]); continue; }
        if (near && r < 0.37) { out.push('haystack', x, y, z, 0, 0.8 + rand() * 0.5, 0.8 + rand() * 0.5, 0.8 + rand() * 0.5, tint(rand, [1, 1, 1])); continue; }
        if (near && r < 0.39) { out.push('buffalo', x, y, z, rand() * 6.28, 1, 1, 1, tint(rand, [1, 1, 1], 0.1)); continue; }
        if (r < 0.5) { tree(x, y, z, g, near, rand); continue; }
        continue;
      }
      const reg = g > 0.5 ? ghats : plains;
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
      const reg = field.ghatAt(info.km[k]) > 0.5 ? ghats : plains;
      if (hash2(cx, cz, 73) > reg.kilnsPerKm2 || info.dist[k] < 150 || info.water[k] || info.road[k] < 40) continue;
      out.push('kiln', x, hAt(x, z), z, hash2(cx, cz, 74) * 6.28, 1, 1, 1, [1, 1, 1]);
    }
    placeColony(route, info, out, hAt);
  }

  const result: Partial<Record<PropType, Float32Array>> = {};
  for (const [t, l] of out.lists) result[t] = new Float32Array(l);
  return result;
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
