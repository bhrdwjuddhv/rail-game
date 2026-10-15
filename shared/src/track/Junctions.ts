import { mirrorRouteData } from './Railway';
import { DEFAULT_LINE_SPACING_M, PostcardData, RouteData, StationData } from './Route';

/**
 * Big junction stations joining two routes (data/junctions). A junction is a
 * long straight with the station in the middle; joining route A (its end at
 * the junction) and route B (its start there) through it gives one continuous
 * route, built here as plain route data: Free Roam drives it like any other,
 * and Route Mode can later join any start and end the same way.
 *
 * The station's lines (lateral offsets; "real" = as built, with the middle
 * line between the running lines):
 *  - through lines in the centre: Down, the middle line, Up (no platforms)
 *  - each side: platform lines on islands, reached from that side's running
 *    line by a ladder of turnouts at both ends; the outermost pair is a bay,
 *    one half entered from each end (terminating / starting trains)
 *  - optionally, on the side away from the building: a freight avoiding line
 *    around everything, a yard of sidings off it, carriage sidings and a loco shed
 */

export type JunctionStyle = 'modern' | 'rajasthani' | 'colonial' | 'dravidian';
/** platform line, bay entered from the low-km end (bay-low) or the high-km end (bay-high), freight avoiding line, sidings (not routed) */
export type LineRole = 'platform' | 'bay-low' | 'bay-high' | 'avoiding' | 'siding' | 'carriage' | 'shed';

export interface JunctionData {
  id: string; name: string; nameHi: string; nameRegional: string; code: string;
  style: JunctionStyle;
  /** the two routes and which of their ends meets the junction (A then B: the joined route runs A -> junction -> B) */
  connects: [{ route: string; end: 'start' | 'end' }, { route: string; end: 'start' | 'end' }];
  region: string; zone: string;
  /** a town road along the junction this far to the side (m, + right; autos and buses on it), or none */
  roadOffsetM?: number;
  platformLinesPerSide: number; platformLengthM: number; buildingSide: 1 | -1;
  avoidingLines: boolean; yardSidings: number; carriageSidings: number;
  /** AI trains: dwell range (s) and how many to keep in the station */
  dwellS: [number, number]; trainsInStation: number;
  /** the high-speed trainset calls here now and then */
  bullet?: boolean;
  /** a hill fort on a ridge this far to the side (m, + right) */
  fortOffsetM?: number;
  trainNames: { express: string[]; mail: string[]; local: string[] };
  /** camera spots: km relative to the station centre */
  postcards?: { name: string; atKm: number; offsetM: number; heightM: number; lookKm?: number }[];
}

/** length (km) of a junction's own straight (approaches, signals, throats, station) */
export const JUNCTION_SECTION_KM = 5;
/** running line offset with a middle line (all three routes have one) */
const RUN = DEFAULT_LINE_SPACING_M;
const CLEAR = 1.7;    // platform edge from the track centre
const ISLAND = 9;     // island platform width
const SIDE_PF = 10;   // side platform width
const GAP = 5;        // track centres without a platform between

/** Lateral position as written in station data: drawn for running lines at half the spacing; Route.spread moves it out. */
const toData = (real: number) => real - Math.sign(real) * (RUN - RUN / 2);

/** The junction as station data at `km`, and the camera spots. */
export function junctionStation(j: JunctionData, km: number): StationData {
  const lines: StationData['lines'] = [];
  const platforms: StationData['platforms'] = [];
  const numbers: Record<string, string> = {};
  const n = Math.max(2, Math.min(6, Math.round(j.platformLinesPerSide)));
  // numbering: from the building side's outermost line in to the centre, then out on the other side
  let next = 1;
  const sides = [j.buildingSide, -j.buildingSide as 1 | -1];
  const plan = sides.map(side => {
    // routable lines with a platform, inner to outer: n platform lines, then the bay pair (one offset)
    const offs: number[] = [];
    let x = RUN + GAP;
    const m = n + 1;
    for (let i = 0; i < m; i++) { offs.push(x); x += i % 2 === 0 ? CLEAR * 2 + ISLAND : GAP; }
    return { side, offs };
  });
  for (const { side, offs } of plan) {
    const ids: string[] = [];
    const order = side === j.buildingSide ? [...offs.keys()].reverse() : [...offs.keys()];
    const idOf = new Map<number, string[]>();
    for (const i of order) {
      const num = String(next++);
      if (i === offs.length - 1) {
        const lo = `P${num}A`, hi = `P${num}B`;
        lines.push({ id: lo, offset: toData(side * offs[i]), role: 'bay-low' }, { id: hi, offset: toData(side * offs[i]), role: 'bay-high' });
        numbers[lo] = `${num}A`; numbers[hi] = `${num}B`;
        idOf.set(i, [lo, hi]);
      } else {
        lines.push({ id: `P${num}`, offset: toData(side * offs[i]), role: 'platform' });
        numbers[`P${num}`] = num;
        idOf.set(i, [`P${num}`]);
      }
      ids.push(...idOf.get(i)!);
    }
    // islands between pairs of lines (inner first); an odd last line, or the building side, gets a side platform beyond
    const label = (is: number[]) => is.map(i => idOf.get(i)!.map(id => numbers[id].replace(/[AB]$/, ''))[0]).join('/');
    for (let i = 0; i + 1 < offs.length; i += 2) {
      const a = offs[i] + CLEAR, b = offs[i + 1] - CLEAR;
      platforms.push({ num: label([i, i + 1]), from: toData(side * a), to: toData(side * b), lines: [...idOf.get(i)!, ...idOf.get(i + 1)!] });
    }
    const last = offs.length - 1;
    if (offs.length % 2 === 1 || side === j.buildingSide) {
      const a = offs[last] + CLEAR;
      platforms.push({ num: label([last]), from: toData(side * a), to: toData(side * (a + SIDE_PF)), lines: idOf.get(last)! });
    }
    // away from the building: freight avoiding line, yard, carriage sidings, loco shed
    if (side !== j.buildingSide) {
      let y = offs[last] + CLEAR + (offs.length % 2 === 1 ? SIDE_PF + 6 : 8);
      if (j.avoidingLines) { lines.push({ id: 'AVL', offset: toData(side * y), role: 'avoiding' }); y += 7; }
      for (let i = 0; i < j.yardSidings; i++) { lines.push({ id: `Y${i + 1}`, offset: toData(side * y), role: 'siding' }); y += 4.8; }
      if (j.yardSidings) y += 4;
      for (let i = 0; i < j.carriageSidings; i++) { lines.push({ id: `C${i + 1}`, offset: toData(side * y), role: 'carriage' }); y += 5.2; }
      for (let i = 0; i < 2; i++) { lines.push({ id: `S${i + 1}`, offset: toData(side * y), role: 'shed' }); y += 6; }
    }
  }
  return {
    name: j.name, nameHi: j.nameHi, nameRegional: j.nameRegional, code: j.code, km,
    type: 'junction', platformLengthM: j.platformLengthM, buildingSide: j.buildingSide,
    lines, platforms, numbers, junction: { id: j.id, style: j.style },
  };
}

/** Every km field of route data moved by `dkm` (joining routes end to end). */
export function shiftRoute(d: RouteData, dkm: number): RouteData {
  const k = (x: number) => +(x + dkm).toFixed(6);
  const range = <T extends { fromKm: number; toKm: number }>(r: T): T => ({ ...r, fromKm: k(r.fromKm), toKm: k(r.toKm) });
  return {
    ...d,
    profile: d.profile.map(p => ({ ...p, km: k(p.km) })),
    regions: d.regions.map(range),
    stations: d.stations.map(s => ({ ...s, km: k(s.km), crossovers: s.crossovers?.map(c => ({ ...c, km: k(c.km) })) })),
    signals: d.signals.map(s => ({ ...s, km: k(s.km) })),
    speedLimits: d.speedLimits.map(range),
    structures: d.structures.map(range),
    levelCrossings: d.levelCrossings.map(l => ({ ...l, km: k(l.km) })),
    scenery: d.scenery.map(range),
    features: d.features.map(f => ({ ...f, km: k(f.km) })),
    landforms: d.landforms?.map(l => ({ ...l, km: k(l.km), toKm: l.toKm === undefined ? undefined : k(l.toKm) })),
    riversAlong: d.riversAlong?.map(range),
    postcards: d.postcards?.map(p => ({ ...p, km: k(p.km), lookKm: p.lookKm === undefined ? undefined : k(p.lookKm) })),
    crossovers: d.crossovers?.map(c => ({ ...c, km: k(c.km) })),
    sea: d.sea && { ...d.sea, fromKm: k(d.sea.fromKm), toKm: d.sea.toKm === undefined ? undefined : k(d.sea.toKm) },
  };
}

const lengthOf = (d: RouteData) => d.segments.reduce((a, s) => a + s.lengthM, 0) / 1000;

/** id of the route joining a junction's two routes */
export const joinedRouteId = (j: JunctionData) => `${j.connects[0].route}~${j.id}~${j.connects[1].route}`;

/**
 * One route: A (turned round if it meets the junction at its start), the
 * junction's straight with the station in its middle, then B (turned round if
 * it meets the junction at its end). Everything of A and B keeps its place on
 * the line; B's km follow on.
 */
export function joinThroughJunction(j: JunctionData, routes: Record<string, RouteData>): RouteData | null {
  const [ca, cb] = j.connects;
  const a0 = routes[ca.route], b0 = routes[cb.route];
  if (!a0 || !b0) return null;
  const turn = (d: RouteData) => mirrorRouteData(d, lengthOf(d));
  const A = ca.end === 'end' ? a0 : turn(a0);
  const B1 = cb.end === 'start' ? b0 : turn(b0);
  const la = lengthOf(A), J = JUNCTION_SECTION_KM, j0 = la, j1 = la + J, mid = la + J / 2;
  const B = shiftRoute(B1, j1);
  const st = junctionStation(j, +mid.toFixed(6));
  const half = j.platformLengthM / 2000;
  const postcards: PostcardData[] = (j.postcards ?? []).map(p => ({ name: `${j.name}: ${p.name}`, km: mid + p.atKm, offsetM: p.offsetM, heightM: p.heightM, lookKm: p.lookKm === undefined ? undefined : mid + p.lookKm }));
  // A's coast runs on along the junction (a port city by the sea) and stops before B's line
  const seaA = A.sea && { ...A.sea, toKm: A.sea.toKm ?? j1 - 0.3 };
  return {
    ...A,
    id: joinedRouteId(j), name: `${a0.name} → ${j.name} → ${b0.name}`, lengthKm: +(la + J + lengthOf(B1)).toFixed(3),
    freight: false, oheContactHeightM: Math.max(a0.oheContactHeightM ?? 5.55, b0.oheContactHeightM ?? 5.55),
    segments: [...A.segments, { type: 'straight', lengthM: J * 1000 }, ...B.segments],
    profile: [...A.profile, { km: j0, gradient: 'level' }, ...B.profile],
    regions: [...A.regions.map(r => ({ ...r, toKm: Math.min(r.toKm, j0) })).filter(r => r.toKm > r.fromKm), { fromKm: j0, toKm: j1, region: j.region }, ...B.regions.map(r => ({ ...r, fromKm: Math.max(r.fromKm, j1) }))],
    stations: [...A.stations, st, ...B.stations],
    signals: [...A.signals, ...B.signals],
    speedLimits: [...A.speedLimits.map(r => ({ ...r, toKm: Math.min(r.toKm, j0) })).filter(r => r.toKm > r.fromKm),
      { fromKm: j0, toKm: mid - half - 1.3, kmph: 100 }, { fromKm: mid - half - 1.3, toKm: mid + half + 1.3, kmph: 50 }, { fromKm: mid + half + 1.3, toKm: j1, kmph: 100 },
      ...B.speedLimits.map(r => ({ ...r, fromKm: Math.max(r.fromKm, j1) }))],
    structures: [...A.structures, ...B.structures],
    levelCrossings: [...A.levelCrossings, ...B.levelCrossings],
    scenery: [...A.scenery.map(z => ({ ...z, toKm: Math.min(z.toKm, j0) })).filter(z => z.toKm > z.fromKm), { fromKm: j0, toKm: j1, zone: j.zone, ...(j.roadOffsetM ? { roadOffset: j.roadOffsetM } : {}) }, ...B.scenery],
    features: [...A.features, ...(j.fortOffsetM ? [{ type: 'fort', km: mid - 0.6, offsetM: j.fortOffsetM }] : []), ...B.features],
    landforms: [...(A.landforms ?? []), ...(B.landforms ?? [])],
    riversAlong: [...(A.riversAlong ?? []), ...(B.riversAlong ?? [])],
    postcards: [...(A.postcards ?? []), ...postcards, ...(B.postcards ?? [])],
    crossovers: [...(A.crossovers ?? []), ...(B.crossovers ?? [])],
    billboardZones: [...new Set([...(A.billboardZones ?? []), ...(B.billboardZones ?? [])])],
    sea: seaA ?? B.sea,
  };
}

/**
 * For Route Mode later: a junction's platforms by where their trains come from and go to.
 * The Down side (km rising) runs from route A to route B, the Up side from B to A; a bay
 * is entered from one end only (trains start or terminate there).
 */
export interface JunctionPlatform { line: string; number: string; side: 'DOWN' | 'UP'; from: string | null; to: string | null }
export function junctionPlatforms(j: JunctionData): JunctionPlatform[] {
  const st = junctionStation(j, 0), [a, b] = j.connects.map(c => c.route);
  return st.lines.filter(l => l.role === 'platform' || l.role === 'bay-low' || l.role === 'bay-high').map(l => {
    const side = l.offset < 0 ? 'DOWN' : 'UP';
    // Down side: in from A at the low end, out to B at the high end; Up side the other way
    const lowRoute = a, highRoute = b, down = side === 'DOWN';
    const from = l.role === 'bay-high' ? null : (down ? lowRoute : highRoute);
    const to = l.role === 'bay-low' ? null : (down ? highRoute : lowRoute);
    const r = l.role === 'bay-low' ? (down ? { from: lowRoute, to: null } : { from: null, to: lowRoute })
      : l.role === 'bay-high' ? (down ? { from: null, to: highRoute } : { from: highRoute, to: null })
      : { from, to };
    return { line: l.id, number: st.numbers![l.id], side, ...r };
  });
}
