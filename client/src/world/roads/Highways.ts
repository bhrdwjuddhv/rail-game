import type { Route } from '@rail/shared/track/Route';
import { hash2, smoothstep } from '@rail/shared/util';

/**
 * The roads alongside the line, from the scenery zones' roadOffset (no three.js: the terrain worker, scenery
 * placement and the main thread all read them).
 *
 * - street: a town's road (and a colony's, an industrial area's, a terminal's), as the zone gives it.
 * - nh: a National Highway, 4 lanes divided - zone roads on one side of the line, merged into one corridor across
 *   short stretches without a road of their own (a village, fields; never over a bridge or through a tunnel),
 *   at least 4 km long in the plains, desert or coast.
 * - sh: a State Highway, 2 lanes: the shorter ones and the hill roads.
 *
 * A highway eases between its zones' offsets, and at an end not joining a town street it turns away from the line
 * (out to VEER m, inside the terrain's reach of the line) instead of stopping beside it.
 *
 * Left-hand traffic: going up the km a vehicle keeps to the carriageway on its left - the one at smaller offsets
 * (offsets are metres right of the line, facing up the km) - and to its left lane, overtaking on the right one.
 */
export type RoadKind = 'nh' | 'sh' | 'street';

/** a cross-section (m): lanes per direction and their width, the raised median, paved shoulders inside and out, earth shoulder */
export interface Section { lanes: number; lane: number; median: number; inner: number; shoulder: number; earth: number }
export const SECTION: Record<RoadKind, Section> = {
  nh: { lanes: 2, lane: 3.5, median: 3, inner: 0.5, shoulder: 2, earth: 1.5 },
  sh: { lanes: 1, lane: 3.5, median: 0, inner: 0, shoulder: 0, earth: 1.5 },
  street: { lanes: 1, lane: 3.5, median: 0, inner: 0, shoulder: 0, earth: 0.7 },
};
/** half width of the paved road (median included), and of the whole formation (with the earth shoulders) */
export const pavedHalf = (k: RoadKind) => { const s = SECTION[k]; return s.median / 2 + s.inner + s.lanes * s.lane + s.shoulder; };
export const formationHalf = (k: RoadKind) => pavedHalf(k) + SECTION[k].earth;
/** a lane's centre from the road's centre, for traffic going `dir` (+1 up the km); lane 0 the left (slow) one */
export function laneLat(k: RoadKind, dir: 1 | -1, lane: number) {
  const s = SECTION[k];
  return -dir * (s.median / 2 + s.inner + (s.lanes - lane - 0.5) * s.lane);
}

/** how far out a highway's end turns (m from the line) */
export const VEER = 190;
const VEER_KM = 0.7;
/** stretches merged into one highway across at most this (km) without a road */
const GAP_KM = 3;
const STREETS = new Set(['town', 'south-town', 'colony', 'industrial', 'terminal']);
const PASSABLE = new Set(['village', 'fields', 'desert', 'coast']);

export interface ParallelRoad {
  id: string; kind: RoadKind; fromKm: number; toKm: number;
  /** the side of the line it runs on */
  side: 1 | -1;
  /** a fictional route number on its signs and stones ('' for streets) */
  number: string;
  /** offset of its centre from the line at km */
  offsetAt(km: number): number;
  /** km where a level crossing's road meets it (a junction: a median gap, chevrons) */
  junctions: number[];
  /** km of its median's U-turn gaps (nh) */
  gaps: number[];
  /** km of its toll plaza (nh; none or one) */
  tolls: number[];
  /** what stands by it: fuel stations, dhabas, repair shops, tea stalls, lay-bys, a market, bus stops */
  sites: Site[];
  /** km of its roundabouts: where a highway meets a town street */
  roundabouts: number[];
}

/**
 * A place by a road at km. side: which side of the road (as an offset sign: +1 right of it facing up the km);
 * mostly the side away from the line. A market lines both sides (side: the road's own).
 */
export type SiteKind = 'petrol' | 'dhaba' | 'repair' | 'tea' | 'layby' | 'market' | 'busstop';
export interface Site { km: number; kind: SiteKind; side: 1 | -1 }
/** paved ground a site adds beside the carriageway: depth out from it (m) and length along it */
const PAD: Partial<Record<SiteKind, { depth: number; len: number }>> = { petrol: { depth: 16, len: 46 }, dhaba: { depth: 12, len: 40 }, repair: { depth: 10, len: 34 }, layby: { depth: 4, len: 110 } };
/** a roundabout's outer radius and its island's (m) */
export const ROUNDABOUT = { outer: 19, island: 8 };

/**
 * A toll plaza: each carriageway widens from its 9.5 m to TOLL.width (TOLL.lanes booth lanes with an island
 * between and either side) over TOLL.taper m, flat for TOLL.flat m either side of the booths.
 */
export const TOLL = { lanes: 4, lane: 3.2, island: 1.0, taper: 150, flat: 60 };
/** a toll plaza's carriageway width (m) */
export const TOLL_W = TOLL.lanes * TOLL.lane + (TOLL.lanes + 1) * TOLL.island;
/** how much wider a toll plaza makes a carriageway at km */
export function tollFlareAt(r: ParallelRoad, km: number) {
  const s = SECTION[r.kind], w = s.inner + s.lanes * s.lane + s.shoulder;
  let out = 0;
  for (const t of r.tolls) {
    const d = Math.abs(km - t) * 1000;
    out = Math.max(out, (TOLL_W - w) * (1 - smoothstep(TOLL.flat, TOLL.flat + TOLL.taper, d)));
  }
  return out;
}
/**
 * How far the paved road reaches out beyond its carriageway on side e at km (either side's if not given): a toll
 * plaza's widening, a site's forecourt or lay-by (tapered in and out over 15 m).
 */
export function flareAt(r: ParallelRoad, km: number, e?: 1 | -1) {
  let out = tollFlareAt(r, km);
  for (const st of r.sites) {
    const p = PAD[st.kind];
    if (!p || (e !== undefined && st.side !== e)) continue;
    const d = Math.abs(km - st.km) * 1000;
    if (d < p.len / 2 + 15) out = Math.max(out, p.depth * (1 - smoothstep(p.len / 2, p.len / 2 + 15, d)));
  }
  return out;
}

const cache = new WeakMap<Route, ParallelRoad[]>();

export function parallelRoads(route: Route): ParallelRoad[] {
  let out = cache.get(route);
  if (out) return out;
  out = [];
  const zones = route.data.scenery.filter(z => z.toKm > z.fromKm).sort((a, b) => a.fromKm - b.fromKm);
  const structureIn = (a: number, b: number) => route.data.structures.some(s => s.fromKm < b && s.toKm > a);
  type Run = { side: 1 | -1; parts: { fromKm: number; toKm: number; offset: number }[]; region: string };
  const runs: Run[] = [];
  let run: Run | null = null;
  for (const z of zones) {
    if (z.roadOffset && STREETS.has(z.zone)) {
      // a street: as it is
      const off = z.roadOffset;
      out.push(road(`ST${out.length}`, 'street', z.fromKm, z.toKm, off, () => off, route));
      run = null;
      continue;
    }
    if (z.roadOffset) {
      const side = Math.sign(z.roadOffset) as 1 | -1, last = run?.parts[run.parts.length - 1];
      if (run && last && run.side === side && z.fromKm - last.toKm <= GAP_KM && !structureIn(last.toKm, z.fromKm)) run.parts.push({ fromKm: z.fromKm, toKm: z.toKm, offset: z.roadOffset });
      else runs.push((run = { side, parts: [{ fromKm: z.fromKm, toKm: z.toKm, offset: z.roadOffset }], region: route.regionIdAt((z.fromKm + z.toKm) / 2) }));
      continue;
    }
    // a stretch without a road: a highway may pass it, if it is open country
    if (run && !PASSABLE.has(z.zone)) run = null;
  }
  for (const r of runs) {
    const from = r.parts[0].fromKm, to = r.parts[r.parts.length - 1].toKm;
    const hills = /himalaya|alpine|ghats/.test(r.region);
    const kind: RoadKind = to - from >= 4 && !hills ? 'nh' : 'sh';
    // the offset along it: each part's, eased across the joins (and the gaps between parts)
    const parts = r.parts;
    const base = (km: number) => {
      let i = parts.findIndex(p => km < p.toKm);
      if (i < 0) i = parts.length - 1;
      const p = parts[i];
      if (i > 0 && km < p.fromKm + 0.3) {
        const q = parts[i - 1], a = q.toKm - 0.3, b = p.fromKm + 0.3;
        return q.offset + (p.offset - q.offset) * smoothstep(a, b, km);
      }
      return p.offset;
    };
    // its ends turn away from the line, unless a town street carries on there
    const joinsStreet = (km: number) => out!.some(s => s.kind === 'street' && Math.sign(s.offsetAt(s.fromKm)) === r.side && (Math.abs(s.toKm - km) < 0.05 || Math.abs(s.fromKm - km) < 0.05));
    const veerIn = !joinsStreet(from), veerOut = !joinsStreet(to);
    const offsetAt = (km: number) => {
      const b = base(km), reach = r.side * VEER - b;
      let v = 0;
      if (veerIn) v = Math.max(v, 1 - smoothstep(from, from + VEER_KM, km));
      if (veerOut) v = Math.max(v, smoothstep(to - VEER_KM, to, km));
      return b + reach * v;
    };
    const hw = road(`${kind.toUpperCase()}${out.length}`, kind, from, to, r.side, offsetAt, route);
    // a highway meeting a town street ends at a roundabout (the 4 lanes don't narrow to the street's 2 at a line)
    if (kind === 'nh') for (const km of [from, to]) if (joinsStreet(km)) hw.roundabouts.push(km);
    out.push(hw);
  }
  // toll plazas: one on a highway of 5 km or more, near its middle, on the straight part (not where it veers),
  // clear of junctions, bridges, tunnels and stations; no two within 15 km. U-turn gaps keep away from them.
  const placed: number[] = [];
  for (const r of out) {
    if (r.kind !== 'nh' || r.toKm - r.fromKm < 5) continue;
    const clear = (km: number) => km > r.fromKm + VEER_KM + 0.4 && km < r.toKm - VEER_KM - 0.4
      && !route.data.structures.some(s => km > s.fromKm - 0.4 && km < s.toKm + 0.4)
      && !route.stations.some(st => km > st.yardFromKm - 0.3 && km < st.yardToKm + 0.3)
      && !r.junctions.some(j => Math.abs(j - km) < 0.6);
    const mid = (r.fromKm + r.toKm) / 2;
    const km = [0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2, 1.6, -1.6, 2.0, -2.0].map(d => mid + d).find(clear);
    if (km === undefined || placed.some(p => Math.abs(p - km) < 15)) continue;
    placed.push(km);
    r.tolls.push(km);
    r.gaps = r.gaps.filter(g => Math.abs(g - km) > 0.8);
  }
  for (const r of out) if (r.kind !== 'street') r.sites = roadSites(route, r);
  cache.set(route, out);
  return out;
}

/**
 * What stands along a highway, seeded (the same every run): every 1.6-3.2 km a fuel station, a dhaba, a truck
 * repair shop, a tea stall or (4 lanes) a lay-by with trucks resting - clear of junctions, plazas, bridges,
 * stations and the turning ends - mostly on the side away from the line; at its first junction a market lines
 * the road both sides; a bus stop just past each junction on each side.
 */
function roadSites(route: Route, r: ParallelRoad): Site[] {
  const out: Site[] = [], nh = r.kind === 'nh';
  const h = (km: number, salt: number) => hash2(Math.round(km * 100), salt, 6113);
  const busy = (km: number, m: number) => r.tolls.some(t => Math.abs(t - km) < 0.7 + m) || r.junctions.some(j => Math.abs(j - km) < 0.35 + m)
    || r.gaps.some(g => Math.abs(g - km) < 0.15) || route.data.structures.some(s => km > s.fromKm - 0.35 && km < s.toKm + 0.35)
    || route.stations.some(st => km > st.yardFromKm - 0.25 && km < st.yardToKm + 0.25) || r.roundabouts.some(k => Math.abs(k - km) < 0.4);
  for (let km = r.fromKm + VEER_KM + 0.6; km < r.toKm - VEER_KM - 0.6; km += 1.6 + 1.6 * h(km, 1)) {
    if (busy(km, 0)) continue;
    const x = h(km, 2);
    const kind: SiteKind = nh ? (x < 0.3 ? 'petrol' : x < 0.55 ? 'dhaba' : x < 0.72 ? 'repair' : x < 0.86 ? 'tea' : 'layby') : (x < 0.15 ? 'petrol' : x < 0.45 ? 'dhaba' : x < 0.65 ? 'repair' : 'tea');
    out.push({ km, kind, side: kind === 'layby' || h(km, 3) < 0.75 ? r.side : (-r.side as 1 | -1) });
  }
  if (nh && r.junctions.length) out.push({ km: r.junctions[0], kind: 'market', side: r.side });
  // bus stops on the left of each carriageway, just past the junction (traffic going up the km keeps to the
  // smaller offsets: its stop on that side, after the junction)
  for (const j of r.junctions) out.push({ km: j + 0.09, kind: 'busstop', side: -1 }, { km: j - 0.09, kind: 'busstop', side: 1 });
  return out;
}

function road(id: string, kind: RoadKind, fromKm: number, toKm: number, sideOrOffset: number, offsetAt: (km: number) => number, route: Route): ParallelRoad {
  const side = (Math.sign(sideOrOffset) || 1) as 1 | -1;
  // a fictional number: four digits (no real highway has one); a state highway's with its state's letters
  const n = 1000 + Math.floor(hash2(Math.round(fromKm * 100), route.data.id.length, 4441) * 8999);
  const number = kind === 'nh' ? `NH ${n}` : kind === 'sh' ? `SH ${(n % 90) + 110}` : '';
  const junctions = route.data.levelCrossings.map(l => l.km).filter(km => km > fromKm + 0.2 && km < toKm - 0.2);
  // U-turn gaps every 1.5-2.5 km, clear of the junctions (which have their own) and the ends
  const gaps: number[] = [];
  if (kind === 'nh') for (let km = fromKm + 1.2; km < toKm - 1; km += 1.5 + hash2(Math.round(km * 100), 3, 4441)) if (!junctions.some(j => Math.abs(j - km) < 0.4)) gaps.push(km);
  return { id, kind, fromKm, toKm, side, number, offsetAt, junctions, gaps, tolls: [], sites: [], roundabouts: [] };
}

/** The road alongside at km nearest to `lat` (m right of the line), or null. */
export function roadAt(route: Route, km: number, lat?: number): ParallelRoad | null {
  let best: ParallelRoad | null = null, bd = Infinity;
  for (const r of parallelRoads(route)) {
    if (km < r.fromKm || km > r.toKm) continue;
    const d = lat === undefined ? 0 : Math.abs(r.offsetAt(km) - lat);
    if (d < bd) { bd = d; best = r; }
  }
  return best;
}

/** height of a road's surface at km (it keeps to the line's level: on a low embankment across the fields) */
export const roadTop = (route: Route, km: number) => route.alignment.elevationAt(km) - 0.12;

/**
 * Distance from a road as the scenery reads it: metres from the edge of an 8.4 m road (the old one every
 * placement rule was set for), so the wider highways push everything back by their extra width.
 */
export const roadDistance = (k: RoadKind, lat: number) => Math.max(0, lat - (pavedHalf(k) - 3.5));

/** where something stands beside a road at km: `gap` m beyond its formation, on the side away from the line */
export function roadsideLat(r: ParallelRoad, km: number, gap: number) {
  return r.offsetAt(km) + r.side * (formationHalf(r.kind) + gap);
}
