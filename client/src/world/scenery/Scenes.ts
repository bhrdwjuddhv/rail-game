import { hash2, rng } from '@rail/shared/util';
import { newFrame } from '@rail/shared/track/Chainage';
import { biomeOf, type Route } from '@rail/shared/track/Route';
import { buildingType, cellsOf, styleOfRegion } from './buildingKit';
import type { PropType } from './Placement';
import { lifeCells, PAINT_VARIANTS, PERSON_VARIANTS, SHOP_VARIANTS } from './lifeKit';
import { formationHalf, parallelRoads, pavedHalf, roadAt, roadsideLat } from '../roads/Highways';

/** the wall paintings are in (the solid pack processed) */
const PAINTED = lifeCells('life/solid-pack', 'paintings').length > 0;

/**
 * Points of interest between the stations: so the view from the cab is never a long empty field. Along the
 * line, every 0.5 to 1.5 km (by the zone), a scene from the region's library on alternating sides, near
 * (20-80 m), mid (80-300 m) or far (300-650 m) from the track: a village round its big tree, a farmhouse with
 * its tubewell and tractor, fields between bunds with people at work, an orchard, a brick kiln, a dhaba by the
 * highway, a power line marching across, a quarry, terraced fields, a fort's ruined walls... Planned once per
 * route from its data (the same every run), placed per terrain tile by the worker as ordinary instanced props:
 * each prop's spot comes from its scene alone, so a scene split across tiles is whole.
 */
export type SceneKind = 'village' | 'farmhouse' | 'fields' | 'orchard' | 'kiln' | 'treeline' | 'dhaba' | 'powerline' | 'mobiletower'
  | 'watertank' | 'factory' | 'school' | 'cricket' | 'goats' | 'cyclist' | 'solarfarm' | 'fort' | 'stepwell' | 'dunes' | 'quarry'
  | 'terraces' | 'teagarden' | 'woodpile' | 'saltpans' | 'coconut'
  // by a highway (Highways' sites)
  | 'petrol' | 'repair' | 'tea' | 'layby' | 'market';

export interface Scene {
  kind: SceneKind; km: number; lat: number; x: number; z: number; heading: number; seed: number; radius: number; regionId: string;
  /** a roadside scene: where the road's centre is, in its frame's v (m; negative: toward the line), so fronts face it */
  roadV?: number;
  /** a roadside scene: half the road's formation (m) */
  roadHalf?: number;
}

const RADIUS: Record<SceneKind, number> = {
  village: 70, farmhouse: 30, fields: 70, orchard: 50, kiln: 45, treeline: 80, dhaba: 25, powerline: 1300, mobiletower: 12, watertank: 12, factory: 35,
  school: 40, cricket: 30, goats: 20, cyclist: 10, solarfarm: 60, fort: 50, stepwell: 18, dunes: 40, quarry: 50, terraces: 70, teagarden: 60,
  woodpile: 20, saltpans: 70, coconut: 50, petrol: 26, repair: 22, tea: 12, layby: 75, market: 110,
};
/** little scenes with people (cheap, near the line only; left out on Low) */
const LITTLE = new Set<SceneKind>(['cricket', 'goats', 'cyclist']);

type Lib = [SceneKind, number][];
/** the library by landscape; road scenes (dhaba) where a road runs alongside */
function library(biome: string, zone: string, road: boolean): Lib {
  const withRoad = (l: Lib): Lib => (road ? [...l, ['dhaba', 3]] : l);
  if (biome === 'desert') return withRoad([['dunes', 3], ['village', 2], ['solarfarm', 2], ['fort', 1], ['stepwell', 1], ['goats', 1], ['powerline', 1], ['mobiletower', 1], ['treeline', 1], ['cyclist', 1]]);
  if (biome === 'hills') return withRoad([['quarry', 2], ['village', 2], ['goats', 2], ['treeline', 2], ['fort', 1], ['powerline', 1], ['mobiletower', 1], ['farmhouse', 1]]);
  if (biome === 'coast') return withRoad([['saltpans', 2], ['coconut', 3], ['village', 2], ['treeline', 1], ['factory', 1], ['powerline', 1], ['cricket', 1]]);
  if (biome === 'snow') return withRoad([['terraces', 3], ['village', 3], ['woodpile', 2], ['treeline', 2], ['teagarden', zone === 'fields' ? 2 : 0], ['goats', 1], ['mobiletower', 1]]);
  if (biome === 'ghats') return withRoad([['treeline', 2], ['coconut', 2], ['village', 2], ['orchard', 1], ['goats', 1], ['mobiletower', 1], ['cyclist', 1]]);
  return withRoad([['village', 3], ['farmhouse', 3], ['fields', 3], ['orchard', 2], ['kiln', 1], ['treeline', 3], ['powerline', 1], ['mobiletower', 1],
    ['watertank', 1], ['school', 1], ['factory', 0.5], ['cricket', 1], ['goats', 1], ['cyclist', 1]]);
}

const SPACING: Record<string, [number, number]> = { fields: [0.35, 0.7], village: [0.45, 0.85], ghats: [0.7, 1.3], desert: [0.4, 0.8], hills: [0.4, 0.8], coast: [0.4, 0.8], snow: [0.4, 0.8], river: [1.2, 1.8], industrial: [0.8, 1.3] };

const plans = new WeakMap<Route, Scene[]>();
export function planScenes(route: Route): Scene[] {
  const hit = plans.get(route);
  if (hit) return hit;
  const out: Scene[] = [], f = newFrame(), L = route.lengthKm, r = rng(Math.floor(hash2(Math.round(L * 1000), 3, 601) * 4294967296));
  const lcs = route.data.levelCrossings.map(l => l.km);
  let side = r() < 0.5 ? 1 : -1;
  for (let km = 0.3; km < L - 0.3;) {
    // (the closer spacing of this zone and the next one coming: a busy zone is crossed in short steps, so the
    // first scene after a town or yard is soon after it)
    const z = route.zoneAt(km), sp = SPACING[z.zone], ahead = SPACING[route.zoneAt(km + 0.5).zone];
    const lo = Math.min(sp?.[0] ?? 9, ahead?.[0] ?? 9), hi = Math.min(sp?.[1] ?? 9, ahead?.[1] ?? 9);
    const step = sp ? lo + r() * (hi - lo) : (r(), 0.2);
    const pick = r(), band = r(), jitter = r(), flip = r();
    km += step;
    const z2 = route.zoneAt(km);
    if (!SPACING[z2.zone]) continue; // towns, colonies, terminals: busy already
    // (not in station yards, nor right by bridges, tunnels and level crossings: those are scenes of their own; a
    // scene that would land on one moves on past it once)
    const blocked = (k: number) => route.stations.some(st => k > st.yardFromKm - 0.15 && k < st.yardToKm + 0.15) || !!route.structureAt(k) || lcs.some(l => Math.abs(l - k) < 0.12);
    if (blocked(km)) { km += 0.15; if (blocked(km) || km > L - 0.3) continue; }
    const regionId = route.regionIdAt(km), biome = biomeOf(route.regions[regionId]);
    const lib = library(biome, z2.zone, !!roadAt(route, km)), total = lib.reduce((a, [, w]) => a + w, 0);
    let x = pick * total, kind: SceneKind = lib[0][0];
    for (const [k, w] of lib) if ((x -= w) <= 0) { kind = k; break; }
    // alternating sides (now and then the same side twice); near, mid or far from the line
    side = flip < 0.8 ? -side : side;
    const near = kind === 'cyclist' || kind === 'goats' || kind === 'cricket' || kind === 'dhaba';
    let dist = near ? 30 + band * 50 : band < 0.4 ? 40 + band * 100 : band < 0.8 ? 90 + (band - 0.4) * 500 : 300 + (band - 0.8) * 1700;
    if (kind === 'powerline') dist = 0;
    // a road scene sits on the road's far side; everything keeps clear of the formation
    const rd = kind === 'dhaba' ? roadAt(route, km) : null;
    if (rd) { side = rd.side; dist = Math.abs(roadsideLat(rd, km, 4 + RADIUS.dhaba * 0.5)); }
    const lat = side * Math.max(dist, route.formationHalfWidth(km) + RADIUS[kind] * 0.4 + 8) + (jitter - 0.5) * 10;
    route.alignment.sampleOffset(km * 1000, lat, f);
    out.push({ kind, km, lat, x: f.x, z: f.z, heading: f.heading, seed: Math.floor(jitter * 1e6) + out.length * 7919, radius: RADIUS[kind], regionId });
  }
  // the places by the highways
  for (const rd of parallelRoads(route)) for (const st of rd.sites) {
    if (st.kind === 'busstop') continue;
    const km = st.km, c = rd.offsetAt(km), ph = pavedHalf(rd.kind), fh = formationHalf(rd.kind);
    // (a fuel station's canopy, a repair shop's truck and a dhaba's charpais stand on their forecourts)
    const out0 = { petrol: ph + 9, dhaba: ph + 6, repair: ph + 6, tea: fh + 3, layby: ph + 2, market: 0 }[st.kind];
    const lat = c + st.side * out0;
    route.alignment.sampleOffset(km * 1000, lat, f);
    const kind = st.kind as SceneKind, sideOfLine = Math.sign(lat) || 1;
    out.push({ kind, km, lat, x: f.x, z: f.z, heading: f.heading, seed: Math.floor(hash2(Math.round(km * 1000), 5, 8209) * 1e6), radius: RADIUS[kind], regionId: route.regionIdAt(km),
      roadV: (c - lat) * sideOfLine, roadHalf: fh });
  }
  plans.set(route, out);
  return out;
}

export type Put = (t: PropType, x: number, z: number, ry: number, sx: number, sy: number, sz: number, c: [number, number, number]) => void;
export interface SceneCtx { put: Put; water: (x: number, z: number) => boolean; road: (x: number, z: number) => number; full: boolean; detail: boolean; route: Route }

const CLOTH: [number, number, number][] = [[0.85, 0.15, 0.2], [0.95, 0.55, 0.1], [0.2, 0.45, 0.85], [0.95, 0.85, 0.2], [0.55, 0.2, 0.6], [0.15, 0.6, 0.35], [0.95, 0.95, 0.92]];
const W: [number, number, number] = [1, 1, 1];

/** Place the scenes reaching into the tile [x0, x0 + size) x [z0, z0 + size). */
export function placeScenes(route: Route, x0: number, z0: number, size: number, ctx: SceneCtx) {
  for (const s of planScenes(route)) {
    if (s.x + s.radius < x0 || s.x - s.radius > x0 + size || s.z + s.radius < z0 || s.z - s.radius > z0 + size) continue;
    if (LITTLE.has(s.kind) && (!ctx.detail || !ctx.full)) continue;
    const inside = (x: number, z: number) => x >= x0 && x < x0 + size && z >= z0 && z < z0 + size;
    expand(s, ctx, inside);
  }
}

/** One scene's props: positions in its own frame (u along the line, v away from it), the same whichever tile asks. */
function expand(s: Scene, ctx: SceneCtx, inside: (x: number, z: number) => boolean) {
  const r = rng(s.seed), side = Math.sign(s.lat) || 1;
  const t = { x: Math.cos(s.heading), z: Math.sin(s.heading) }, n = { x: -Math.sin(s.heading) * side, z: Math.cos(s.heading) * side };
  const toLine = -s.heading + (side > 0 ? Math.PI : 0); // a yaw facing back toward the line
  const P = (u: number, v: number) => ({ x: s.x + t.x * u + n.x * v, z: s.z + t.z * u + n.z * v });
  const put = (type: PropType, u: number, v: number, ry: number, sc: [number, number, number] | number = 1, c: [number, number, number] = W) => {
    const p = P(u, v);
    if (!inside(p.x, p.z) || ctx.water(p.x, p.z) || ctx.road(p.x, p.z) < 4) return;
    const [sx, sy, sz] = typeof sc === 'number' ? [sc, sc, sc] : sc;
    ctx.put(type, p.x, p.z, ry, sx, sy, sz, c);
  };
  const small = (type: PropType, u: number, v: number, ry: number, sc: [number, number, number] | number = 1, c: [number, number, number] = W) => { if (ctx.detail && ctx.full) put(type, u, v, ry, sc, c); };
  // (a person in one of twelve outfits, tinted a little: seeded per person)
  const person = (u: number, v: number, ry: number) => small(`person${Math.floor(r() * PERSON_VARIANTS)}` as PropType, u, v, ry, 1, [0.9 + r() * 0.1, 0.9 + r() * 0.1, 0.9 + r() * 0.1]);
  const tree = (type: PropType, u: number, v: number, sc = 1) => {
    if (ctx.full) put(type, u, v, r() * 6.28, sc * (0.8 + r() * 0.4), [0.95 + r() * 0.1, 0.95 + r() * 0.1, 0.95]);
    else put(type === 'palm' || type === 'banana' ? 'palmImp' : type === 'pine' ? 'pineImp' : 'treeImp', u, v, r() * 6.28, sc);
  };
  const style = styleOfRegion(s.regionId), houses = cellsOf(style, ['house', 'shop'], 7.5);
  // a roadside scene: v away from the road (fv) and fronts facing it (face); else the road is toward the line
  const fv = (s.roadV ?? -1) < 0 ? 1 : -1, face = fv > 0 ? toLine : toLine + Math.PI;
  const house = (u: number, v: number, ry: number) => {
    if (houses.length) put(buildingType(style, houses[Math.floor(r() * houses.length)], r() < 0.5 ? 0 : 1), u, v, ry, 1, [0.92 + r() * 0.1, 0.92 + r() * 0.08, 0.92]);
    else put('hut', u, v, ry, 0.9);
  };
  const faceTo = (u: number, v: number, cu: number, cv: number) => {
    const a = P(u, v), b = P(cu, cv);
    return Math.atan2(b.x - a.x, b.z - a.z);
  };
  const bigTree = style === 'desert' ? 'neem' : style === 'himalayan' ? 'pine' : 'mango';
  switch (s.kind) {
    case 'village': {
      // houses in a ring round the village tree on its raised platform - facing in, or out to the line on its side
      // (fronts to the passing train, never a row of blank backs); the hand pump, the chaupal, cattle, haystacks,
      // cots and washing out front; cow-dung cakes on a wall
      put('chabutra', 0, 0, 0);
      tree(bigTree, 0, 0, 1.7);
      const n = 6 + Math.floor(r() * 10);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + r() * 0.3, d = 24 + r() * 16, u = Math.cos(a) * d, v = Math.sin(a) * d;
        const a0 = P(u, v), c0 = P(0, 0), lineSide = (a0.x - c0.x) * Math.sin(toLine) + (a0.z - c0.z) * Math.cos(toLine) > 0;
        (r() < 0.3 ? (uu: number, vv: number, ry: number) => put('hut', uu, vv, ry, 0.9) : house)(u, v, lineSide ? toLine : faceTo(u, v, 0, 0));
        if (r() < 0.5) small('charpai', u * 0.7, v * 0.7, r() * 3, 1, [0.95, 0.9, 0.8]);
        if (r() < 0.35) small('clothesline', u * 0.78, v * 0.78, a, 1, W);
      }
      put('handpump', 6, -3, r() * 6);
      put('chaupal', -8, 5, faceTo(-8, 5, 0, 0));
      for (let i = 0; i < 3; i++) put(r() < 0.5 ? 'cow' : 'buffalo', -14 + r() * 28, -18 - r() * 10, r() * 6.28, 1, [0.95, 0.95, 0.95]);
      for (let i = 0; i < 3; i++) put('haystack', 30 + r() * 12, -10 + r() * 20, 0, 0.8 + r() * 0.4);
      small('dungcakes', -30, 0, Math.PI / 2);
      put(PAINTED ? `wallpaint${Math.floor(r() * PAINT_VARIANTS)}` as PropType : 'wallad', 0, -44, toLine + Math.PI);
      for (let i = 0; i < 2; i++) small('dog', -10 + r() * 20, -12 + r() * 6, r() * 6.28, 1, [0.7 + r() * 0.25, 0.55 + r() * 0.2, 0.4]);
      for (let i = 0; i < 3; i++) person(-6 + r() * 12, -6 + r() * 12, r() * 6.28);
      return;
    }
    case 'farmhouse': {
      house(0, 0, toLine);
      put('tubewell', 14, 4, r() * 6);
      put('tractor', -10, -8, r() * 6.28, 1, [0.75 + r() * 0.25, 0.2, 0.15]);
      for (let i = 0; i < 2; i++) put('buffalo', 18 + r() * 8, -12 + r() * 6, r() * 6.28);
      put('haystack', -14, 10, 0);
      tree(bigTree, 10, 18, 1.3);
      small('charpai', 4, -6, 0.4);
      person(2, -8, toLine);
      return;
    }
    case 'fields': {
      // a field pattern: bunds round 4 plots, a scarecrow, people bent at work, a bullock cart on the mud track
      // (a bund runs along its local x: along the line at yaw -heading, across it a quarter turn on)
      for (let i = -2; i <= 2; i++) put('bund', i * 28, 0, -s.heading + Math.PI / 2, [1.9, 1, 1]);
      for (const v of [-28, 0, 28]) put('bund', 0, v, -s.heading, [3.8, 1, 1]);
      small('scarecrow', 10, 10, r() * 6);
      for (let i = 0; i < 4; i++) person(-40 + r() * 80, -20 + r() * 40, r() * 6.28);
      small('bullockcart', -50, -30, -s.heading, 1, [0.9, 0.85, 0.75]);
      tree(bigTree, 58, -30);
      return;
    }
    case 'orchard': case 'coconut': {
      const type: PropType = s.kind === 'coconut' ? 'palm' : style === 'ghats' ? 'banana' : 'mango';
      for (let i = 0; i < 6; i++) for (let j = 0; j < 5; j++) tree(type, -40 + i * 16 + (r() - 0.5) * 2, -32 + j * 16 + (r() - 0.5) * 2, type === 'banana' ? 1 : 0.85);
      return;
    }
    case 'kiln': {
      put('kiln', 0, 0, toLine);
      for (let i = 0; i < 6; i++) put('bricks', -30 + i * 9, 22, -s.heading, 1, [0.95, 0.6 + r() * 0.1, 0.5]);
      for (let i = 0; i < 2; i++) person(-20 + r() * 30, 18, r() * 6);
      return;
    }
    case 'treeline': {
      // a line of trees along a field edge or a cart track, away from the line or along it
      const along = r() < 0.5;
      for (let i = -7; i <= 7; i++) tree(bigTree, along ? i * 11 : (r() - 0.5) * 4, along ? (r() - 0.5) * 4 : i * 11, 1);
      return;
    }
    case 'dhaba': {
      // a highway dhaba: its open kitchen and tandoor (smoke from it), cots out on the forecourt, painted trucks
      // pulled up by the road, string lights for the night (a scene planned by the road knows which way it is)
      put('dhaba', 0, fv * 8, face);
      for (let i = 0; i < 4; i++) small('charpai', -8 + i * 4, fv * 1, r() * 0.4, 1, [0.95, 0.9, 0.8]);
      for (let i = 0; i < 3; i++) put('truckpainted', 16 + i * 7, -fv * 1.5, face + Math.PI / 2, 1, CLOTH[Math.floor(r() * CLOTH.length)]);
      put('stringlights', 0, fv * 3.2, face);
      for (let i = 0; i < 3; i++) person(-6 + r() * 12, fv * (0.5 + r() * 2), r() * 6);
      return;
    }
    case 'petrol': {
      // a fuel station on its forecourt: the canopy over the pumps, a tanker filling the tanks now and then, a car
      // and a scooter at the pumps, the attendant
      put('petrolpump', 0, 0, face);
      if (r() < 0.45) put('tanker', -16, fv * 4, face + Math.PI / 2);
      put('scooter', -2, -fv * 0.5, face + Math.PI / 2, 1, CLOTH[Math.floor(r() * CLOTH.length)]);
      person(1, -fv * 1, face);
      return;
    }
    case 'repair': {
      // a truck repair shop: the tin shed, tyres stacked, a painted truck in on its jack, the mechanic under it
      put('tyreshop', 0, fv * 8, face);
      put('truckpainted', -4, -fv * 1, face + Math.PI / 2 + 0.05, 1, CLOTH[Math.floor(r() * CLOTH.length)]);
      person(-3, fv * 1.5, face);
      person(4, fv * 3, r() * 6);
      return;
    }
    case 'tea': {
      // a tea stall under a tarpaulin, a bench, a truck driver or two having tea, a scooter parked
      put('teastall', 0, fv * 1, face);
      small('charpai', 3, fv * 0.5, face + 0.3, 1, [0.95, 0.9, 0.8]);
      put('scooter', -3.5, -fv * 0.5, face + Math.PI / 2, 1, CLOTH[Math.floor(r() * CLOTH.length)]);
      for (let i = 0; i < 2; i++) person(1 + r() * 3, -fv * (0.5 + r()), r() * 6);
      return;
    }
    case 'layby': {
      // trucks resting in the lay-by; now and then one broken down - branches laid behind it, a triangle out
      const n = 2 + Math.floor(r() * 3), broken = r() < 0.5;
      for (let i = 0; i < n; i++) put('truckpainted', -32 + i * 16, 0, face + Math.PI / 2, 1, CLOTH[Math.floor(r() * CLOTH.length)]);
      if (broken) {
        put('branches', -32 - 9, -fv * 0.4, face);
        put('warntriangle', -32 - 16, -fv * 0.6, face + Math.PI / 2);
        person(-32 + 2, fv * 1.6, r() * 6);
      }
      return;
    }
    case 'market': {
      // a market on the highway through a village: shops on both sides facing it, stalls and carts in front, people,
      // a cow wandering, scooters and autos pulled in
      const half = (s.roadHalf ?? 12) + 5;
      for (const sv of [-1, 1]) {
        const v0 = sv * half, ry = sv * side > 0 ? toLine : toLine + Math.PI;
        for (let u = -90; u <= 90; u += 6) {
          if (Math.abs(u) < 12 || r() < 0.15) continue;
          put(`shop${Math.floor(r() * SHOP_VARIANTS)}` as PropType, u, v0 + sv * 1.5, ry);
          if (r() < 0.35) put((['handcart', 'cylindercart', 'scooter', 'autorickshaw', 'rickshaw'] as PropType[])[Math.floor(r() * 5)], u + 2, v0 - sv * 1.6, ry + Math.PI / 2, 1, CLOTH[Math.floor(r() * CLOTH.length)]);
          if (r() < 0.4) person(u + r() * 3, v0 - sv * (1 + r() * 1.5), r() * 6);
        }
      }
      put('cow', -20 + r() * 40, half - 2, r() * 6, 1, [0.95, 0.95, 0.95]);
      return;
    }
    case 'powerline': {
      // a high-tension line crossing the land on lattice towers, wires between them
      const skew = (r() - 0.5) * 0.6, span = 300;
      for (let k = -4; k <= 4; k++) {
        const v = k * span + side * 0, u = Math.tan(skew) * v;
        if (Math.abs(k * span) < 60) continue; // (never by the track)
        put('pylon', u, v, -s.heading + Math.PI / 2 + skew);
        const a = P(u, v), b = P(Math.tan(skew) * (v + span), v + span);
        if (k < 4 && Math.abs((k + 1) * span) >= 60 && inside(a.x, a.z)) ctx.put('wirespan', a.x, a.z, Math.atan2(b.x - a.x, b.z - a.z) - Math.PI / 2, Math.hypot(b.x - a.x, b.z - a.z), 1, 1, W);
      }
      return;
    }
    case 'mobiletower': put('mobiletower', 0, 0, r() * 6); return;
    case 'watertank': put('watertower', 0, 0, r() * 6); return;
    case 'factory': put('factory', 0, 0, toLine); put('truckpainted', 22, -10, toLine + Math.PI / 2, 1, CLOTH[2]); return;
    case 'school': {
      put('school', 0, 12, toLine);
      for (const u of [-14, 14]) small('goalpost', u, -10, -s.heading + Math.PI / 2);
      for (let i = 0; i < 8; i++) person(-12 + r() * 24, -16 + r() * 10, r() * 6.28);
      return;
    }
    case 'cricket': {
      small('stumps', -10, 0, -s.heading); small('stumps', 10, 0, -s.heading);
      for (let i = 0; i < 9; i++) person(-18 + r() * 36, -14 + r() * 28, r() * 6.28);
      return;
    }
    case 'goats': {
      for (let i = 0; i < 9; i++) small('goat', -8 + r() * 16, -6 + r() * 12, r() * 6.28, 0.9 + r() * 0.2, [0.95, 0.9 - r() * 0.5, 0.85 - r() * 0.6]);
      person(-10, 4, -s.heading);
      return;
    }
    case 'cyclist': small('cyclist', 0, 0, -s.heading + (r() < 0.5 ? 0 : Math.PI), 1, CLOTH[Math.floor(r() * CLOTH.length)]); return;
    case 'solarfarm': for (let i = 0; i < 5; i++) for (let j = 0; j < 4; j++) put('solarpanel', -40 + i * 20, -24 + j * 14, -s.heading); return;
    case 'fort': {
      // an old fort's broken wall on a rise, a chhatri beside it
      for (let i = 0; i < 6; i++) if (r() < 0.8) put('fortwall', -40 + i * 15, 10 + Math.sin(i) * 3, -s.heading + (i % 2) * 0.1, [1, 0.6 + r() * 0.6, 1]);
      put('chhatri', 30, -12, r() * 6);
      put('chhatri', -32, -16, r() * 6);
      return;
    }
    case 'stepwell': put('stepwell', 0, 0, toLine); tree('neem', 12, 10); person(-6, -6, r() * 6); return;
    case 'dunes': {
      for (let i = 0; i < 5; i++) put('camel', -12 + r() * 24, -10 + r() * 20, r() * 6.28, 1, [0.85, 0.7, 0.5]);
      for (let i = 0; i < 6; i++) put('bush', -30 + r() * 60, -30 + r() * 60, r() * 6, 0.7 + r() * 0.4, [0.85, 0.85, 0.6]);
      tree('neem', 20, 18, 0.9);
      person(-14, 0, r() * 6);
      return;
    }
    case 'quarry': {
      for (let i = 0; i < 7; i++) put('rock', -30 + r() * 60, -20 + r() * 40, r() * 6, [2 + r() * 3, 1.5 + r() * 2, 2 + r() * 3], [0.75, 0.65, 0.55]);
      put('truckpainted', 0, -26, -s.heading, 1, CLOTH[1]);
      return;
    }
    case 'terraces': {
      // terraced fields stepping up a slope: stone walls along the contour, a house, pines above
      for (let j = 0; j < 6; j++) put('terrace', 0, -30 + j * 11, -s.heading, [5, 1, 1]);
      house(-30, 40, toLine);
      for (let i = 0; i < 6; i++) tree('pine', -40 + i * 16, 48 + r() * 10);
      return;
    }
    case 'teagarden': for (let i = 0; i < 8; i++) for (let j = 0; j < 6; j++) put('teabush', -42 + i * 12, -30 + j * 12, -s.heading, [1, 1, 1]); return;
    case 'woodpile': house(0, 0, toLine); put('woodstack', 9, -3, toLine); put('woodstack', 9, 3, toLine); tree('pine', 16, 12); return;
    case 'saltpans': {
      for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) put('saltheap', -36 + i * 24, -20 + j * 20, 0, 0.8 + r() * 0.5);
      for (let i = 0; i < 4; i++) person(-30 + r() * 60, -10 + r() * 20, r() * 6);
      return;
    }
  }
}
