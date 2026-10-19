import { isFreightStock } from '../train/Consist';
import type { RouteData, StationData } from '../track/Route';
import { flipJunction, joinedRouteId, joinRoutes, JUNCTION_SECTION_KM, JunctionData, sliceRoute, turnRoute } from '../track/Junctions';
import { Consist, type CoachData, type ConsistSpec, type LocoData } from '../train/Consist';
import type { ScenarioData } from '../gameplay/Scenario';
import type { TimetableEntry } from '../gameplay/Timetable';
import type { WeatherId } from '../weather';
import type { WorkKind } from '../gameplay/StationWork';

/**
 * Route Mode: a journey from any station to any other across the routes and
 * the junctions that join them. Everything comes from the data (routes,
 * junctions, stations, platforms): a new route or junction joins the network
 * by itself.
 *
 * The network is the routes' ends linked through junctions. A path is a list
 * of legs (a route travelled one way: wholly in the middle of a journey,
 * partly at its ends) with the junctions between them; it is built into one
 * route (each leg turned round if travelled from its far end, joined through
 * each junction, a junction met from its other side flipped), so the game
 * drives it like any other route, always on the Down line.
 */

export interface NetStation { code: string; name: string; route: string; km: number; type: StationData['type']; platformLengthM: number }
/** a route travelled from start to end (reversed: from end to start) */
export interface PathLeg { route: string; reversed: boolean }
export interface JourneyPath { from: string; to: string; legs: PathLeg[]; junctions: string[]; distanceKm: number }

/** what to do at a station of the journey */
export interface JourneyStop {
  code: string;
  stop: boolean;
  dwellS: number;
  /** leave the last N vehicles here */
  decouple?: number;
  /** pick up coaches or wagons waiting here (added at the rear) */
  couple?: { type: string; count: number }[];
  /** change the loco here (junctions) */
  changeLoco?: string;
  /** the work at the platform: passengers boarding, wagons loaded or unloaded; none: [] (default: see stopWork) */
  work?: WorkKind[];
}
export interface Journey {
  v: 1;
  name?: string;
  from: string; to: string;
  /** which way: the junction ids passed through (empty: the same route) */
  via: string[];
  time: string; weather: WeatherId;
  consist: ConsistSpec;
  stops: JourneyStop[];
  /** realistic rules: passenger trains kept off freight-only lines */
  realistic: boolean;
  /** the game does coupling moves by itself */
  autoShunt: boolean;
  /** a journey going on after a loco change: what was done before (for the summary at the end) */
  carry?: { title: string; minutes: number; km: number; stops: { name: string; errM: number }[]; bumps: number; jolt: number };
}

const lengthOf = (d: RouteData) => d.segments.reduce((a, s) => a + s.lengthM, 0) / 1000;

export class RailNetwork {
  /** the routes as built (not the junctions' own joined routes) */
  readonly routes: Record<string, RouteData> = {};
  readonly junctions: JunctionData[];
  readonly stations = new Map<string, NetStation>();

  constructor(all: Record<string, RouteData>, junctions: Record<string, JunctionData>) {
    this.junctions = Object.values(junctions).filter(j => j.connects.every(c => all[c.route]));
    const joined = new Set(Object.values(junctions).map(joinedRouteId));
    // (not the junctions' joined routes, nor journeys built earlier: ids rm:...)
    for (const [id, r] of Object.entries(all)) if (!joined.has(id) && !id.startsWith('rm:')) this.routes[id] = r;
    for (const r of Object.values(this.routes)) for (const s of r.stations) this.stations.set(s.code, { code: s.code, name: s.name, route: r.id, km: s.km, type: s.type, platformLengthM: s.platformLengthM });
    for (const j of this.junctions) this.stations.set(j.code, { code: j.code, name: j.name, route: `junction:${j.id}`, km: 0, type: 'junction', platformLengthM: j.platformLengthM });
  }

  lengthKm(route: string) { return lengthOf(this.routes[route]); }
  junctionByCode(code: string) { return this.junctions.find(j => j.code === code); }

  /**
   * Ways from one station to another, shortest first (at most `max`, none more than three times the
   * shortest). Each route is used at most once; junction stations can be the start or the end.
   */
  paths(from: string, to: string, max = 3): JourneyPath[] {
    const a = this.stations.get(from), b = this.stations.get(to);
    if (!a || !b || from === to) return [];
    // where a station is: on a route at km, or a junction (between two route ends)
    type End = { route: string; end: 'start' | 'end' };
    const ends = (s: NetStation): { at: End; km: number }[] => {
      const j = this.junctionByCode(s.code);
      if (j) return j.connects.map(c => ({ at: c, km: JUNCTION_SECTION_KM / 2 }));
      const L = this.lengthKm(s.route);
      return [{ at: { route: s.route, end: 'start' }, km: s.km }, { at: { route: s.route, end: 'end' }, km: L - s.km }];
    };
    const out: JourneyPath[] = [];
    // same route (neither is a junction): straight along it
    if (a.route === b.route && !this.junctionByCode(from)) out.push({ from, to, legs: [{ route: a.route, reversed: b.km < a.km }], junctions: [], distanceKm: Math.abs(b.km - a.km) });
    // through junctions: leave a's route by one end, cross whole routes, enter b's route by an end
    const joins = (end: End) => this.junctions.filter(j => j.connects.some(c => c.route === end.route && c.end === end.end));
    const other = (j: JunctionData, end: End) => j.connects.find(c => !(c.route === end.route && c.end === end.end))!;
    const fromJ = this.junctionByCode(from), toJ = this.junctionByCode(to);
    const search = (end: End, dist: number, legs: PathLeg[], via: JunctionData[], used: Set<string>) => {
      for (const j of joins(end)) {
        if (via.includes(j)) continue;
        const next = other(j, end), d = dist + JUNCTION_SECTION_KM;
        // arrived: the junction itself, or b's route entered by this end
        if (toJ === j) { out.push({ from, to, legs, junctions: [...via, j].map(x => x.id), distanceKm: dist + JUNCTION_SECTION_KM / 2 }); continue; }
        // (never back onto a route already travelled: no loops round the network)
        if (!toJ && next.route === b.route && !used.has(b.route)) out.push({ from, to, legs: [...legs, { route: b.route, reversed: next.end === 'end' }], junctions: [...via, j].map(x => x.id), distanceKm: d + (next.end === 'start' ? b.km : this.lengthKm(b.route) - b.km) });
        // or across the whole of that route to its other end
        if (used.has(next.route) || via.length >= 4) continue;
        const far: End = { route: next.route, end: next.end === 'start' ? 'end' : 'start' };
        search(far, d + this.lengthKm(next.route), [...legs, { route: next.route, reversed: next.end === 'end' }], [...via, j], new Set([...used, next.route]));
      }
    };
    if (fromJ) {
      // from a junction: out along either of its routes
      for (const c of fromJ.connects) {
        if (!toJ && c.route === b.route) out.push({ from, to, legs: [{ route: c.route, reversed: c.end === 'end' }], junctions: [fromJ.id], distanceKm: JUNCTION_SECTION_KM / 2 + (c.end === 'start' ? b.km : this.lengthKm(b.route) - b.km) });
        const far: End = { route: c.route, end: c.end === 'start' ? 'end' : 'start' };
        search(far, JUNCTION_SECTION_KM / 2 + this.lengthKm(c.route), [{ route: c.route, reversed: c.end === 'end' }], [fromJ], new Set([c.route]));
      }
    } else for (const e of ends(a)) search(e.at, e.km, [{ route: a.route, reversed: e.at.end === 'start' }], [], new Set([a.route]));
    // (a path starting at a junction lists it first; drop the duplicates the search can find twice)
    const seen = new Set<string>();
    const uniq = out.filter(p => { const k = p.legs.map(l => l.route + (l.reversed ? '-' : '+')).join() + '|' + p.junctions.join(); if (seen.has(k)) return false; seen.add(k); return true; });
    uniq.sort((x, y) => x.distanceKm - y.distanceKm);
    return uniq.filter(p => p.distanceKm <= uniq[0].distanceKm * 3).slice(0, max);
  }

  /**
   * A whole route with the junction at each of its ends (free roam): from the one at its start to the one at
   * its end (a route end without a junction: its own end station). Null for an unknown route.
   */
  span(routeId: string): RouteData | null {
    const r = this.routes[routeId];
    if (!r?.stations.length) return null;
    const at = (end: 'start' | 'end') => this.junctions.find(j => j.connects.some(c => c.route === routeId && c.end === end));
    const from = at('start')?.code ?? r.stations[0].code, to = at('end')?.code ?? r.stations[r.stations.length - 1].code;
    const p = this.paths(from, to, 8).find(x => x.legs.length === 1 && x.legs[0].route === routeId && !x.legs[0].reversed);
    if (!p) return null;
    // (a junction is built with the routes on both its sides: the part from the first junction's section to the
    // last one's, without the neighbouring routes beyond)
    const c = this.compose(p), s0 = c.stations.find(s => s.code === from), s1 = c.stations.find(s => s.code === to);
    const half = JUNCTION_SECTION_KM / 2;
    const part = s0 && s1 ? sliceRoute(c, this.junctionByCode(from) ? s0.km - half : 0, this.junctionByCode(to) ? s1.km + half : c.lengthKm) : c;
    return { ...part, id: c.id, name: r.name };
  }

  /** The path's way, as the journey keeps it (the junctions passed through). */
  pathFor(from: string, to: string, via: string[]) {
    const all = this.paths(from, to, 8);
    return all.find(p => p.junctions.join() === via.join()) ?? all[0] ?? null;
  }

  /**
   * The path built into one route, travelled in rising km. A journey from or to a junction station
   * includes the junction's straight at that end.
   */
  compose(path: JourneyPath): RouteData {
    const id = `rm:${path.junctions.join('+') || 'direct'}:${path.legs.map(l => `${l.route}${l.reversed ? '-' : '+'}`).join('|')}`;
    const orient = (l: PathLeg) => (l.reversed ? turnRoute(this.routes[l.route]) : this.routes[l.route]);
    const js = path.junctions.map(jid => this.junctions.find(j => j.id === jid)!);
    const name = `${this.stations.get(path.from)!.name} → ${this.stations.get(path.to)!.name}`;
    // a journey starting at a junction: its first leg is joined behind the junction's other route
    const startsAtJ = this.junctionByCode(path.from) ? js[0] : null;
    let legs = path.legs, k = 0;
    let C: RouteData;
    if (startsAtJ) {
      // the junction between the leg's route and its other route (taken whole: it is behind the start)
      const into = startsAtJ.connects.find(c => c.route === legs[0].route)!, back = startsAtJ.connects.find(c => c !== into)!;
      C = back.end === 'end' ? this.routes[back.route] : turnRoute(this.routes[back.route]);
      k = 1;
      C = joinRoutes(C, this.oriented(startsAtJ, back.route), orient(legs[0]), id, name);
      legs = legs.slice(1);
    } else C = orient(legs[0]), legs = legs.slice(1);
    for (const leg of legs) {
      const j = js[k++], prev = path.legs[path.legs.indexOf(leg) - 1];
      C = joinRoutes(C, this.oriented(j, prev.route), orient(leg), id, name);
    }
    // a journey ending at a junction: the next route on, beyond it
    if (k < js.length) {
      const j = js[k], last = path.legs[path.legs.length - 1], beyond = j.connects.find(c => c.route !== last.route)!;
      C = joinRoutes(C, this.oriented(j, last.route), beyond.end === 'start' ? this.routes[beyond.route] : turnRoute(this.routes[beyond.route]), id, name);
    }
    return { ...C, id, name };
  }

  /** a junction as met coming from route `from` */
  private oriented(j: JunctionData, from: string) { return j.connects[0].route === from ? j : flipJunction(j); }
}

/** The stations a journey passes, in order (km along the built route), first and last included. */
export function journeyStations(route: RouteData, from: string, to: string) {
  const a = route.stations.find(s => s.code === from)!, b = route.stations.find(s => s.code === to)!;
  return route.stations.filter(s => s.km >= a.km - 1e-6 && s.km <= b.km + 1e-6).sort((x, y) => x.km - y.km);
}

/** The default plan: a stop at every station (junctions 2 min, others 1 min); the player picks the ones to pass. */
export function defaultStops(route: RouteData, from: string, to: string): JourneyStop[] {
  return journeyStations(route, from, to).map(s => ({ code: s.code, stop: true, dwellS: s.junction ? 120 : 60 }));
}

/** Train length (m) and weight (t) for a consist. */
export function trainSize(spec: ConsistSpec, locos: Record<string, LocoData>, coaches: Record<string, CoachData>) {
  const loco = locos[spec.loco];
  if (!loco) return { lengthM: 0, massT: 0, maxKmph: 0 };
  const c = new Consist(loco, coaches, { ...spec, coaches: spec.coaches.filter(x => coaches[x.type] && x.count > 0) });
  return { lengthM: c.length, massT: c.mass / 1000, maxKmph: loco.maxSpeedKmph };
}

/** Estimated running time (minutes): the speed limits along the way (capped by the train), a margin, and the stops. */
export function estimateMinutes(route: RouteData, from: string, to: string, maxKmph: number, stops: JourneyStop[]) {
  const st = journeyStations(route, from, to), a = st[0].km, b = st[st.length - 1].km;
  let min = 0;
  for (let km = a; km < b; km += 0.5) {
    const lim = route.speedLimits.find(l => km >= l.fromKm && km < l.toKm)?.kmph ?? 80;
    min += (Math.min(0.5, b - km) / Math.max(20, Math.min(lim, maxKmph) * 0.85)) * 60;
  }
  for (const s of stops) if (s.stop && s.code !== from) min += s.dwellS / 60 + 1.5; // dwell, braking and starting
  return min;
}

export interface JourneyWarning { level: 'block' | 'warn' | 'note'; text: string; code?: string }

/**
 * What is wrong with a plan, in plain words: a block stops the journey starting (with realistic
 * rules on), a warning or note does not.
 */
export function checkJourney(j: Journey, net: RailNetwork, route: RouteData, locos: Record<string, LocoData>, coaches: Record<string, CoachData>): JourneyWarning[] {
  const out: JourneyWarning[] = [];
  const path = net.pathFor(j.from, j.to, j.via);
  if (!path) return [{ level: 'block', text: 'No way between these two stations' }];
  const loco = locos[j.consist.loco];
  if (!loco) return [{ level: 'block', text: 'Choose a locomotive' }];
  const routesOnPath = path.legs.map(l => net.routes[l.route]);
  const pax = !loco.trainset ? j.consist.coaches.some(c => c.count > 0 && (coaches[c.type]?.kind ?? 'coach') === 'coach') : true;
  // freight-only lines
  for (const r of routesOnPath) if (r.freight && pax) {
    out.push(j.realistic
      ? { level: 'block', text: `${r.name} is for freight only. Turn off "Realistic rules" to take a passenger train on it anyway.` }
      : { level: 'note', text: `${r.name} is freight-only in real life (allowed: Realistic rules are off).` });
  }
  // double-stack containers need the high wires
  const ds = j.consist.coaches.filter(c => c.count > 0 && coaches[c.type]?.containers === 'double');
  if (ds.length) for (const r of routesOnPath) if ((r.oheContactHeightM ?? 5.55) < 7) out.push({ level: 'block', text: `Double-stack can't fit under the wires on ${r.name}: use single-stack wagons.` });
  if (loco.trainset && j.consist.coaches.some(c => c.count > 0)) out.push({ level: 'warn', text: `${loco.name} is a fixed trainset: it runs with its own cars only.` });
  // snow only where it snows
  if (j.weather === 'snow' && !routesOnPath.some(r => r.id.includes('himalaya'))) out.push({ level: 'warn', text: 'Snowfall is only on the Himalayan line: this journey does not reach it.' });
  // the plan, stop by stop, with the train as it changes on the way
  let spec: ConsistSpec = { ...j.consist, coaches: j.consist.coaches.map(c => ({ ...c })) };
  const total = (s: ConsistSpec) => s.coaches.reduce((a, c) => a + c.count, 0);
  const stations = journeyStations(route, j.from, j.to);
  for (const st of stations) {
    const p = j.stops.find(x => x.code === st.code);
    if (!p?.stop) continue;
    if (p.changeLoco) {
      if (!locos[p.changeLoco]) out.push({ level: 'block', code: st.code, text: `Unknown loco for the change at ${st.name}` });
      else if (!st.junction) out.push({ level: 'warn', code: st.code, text: `Loco changes are made at junctions; ${st.name} has no loco shed.` });
      else spec = { ...spec, loco: p.changeLoco };
    }
    if (p.decouple) {
      if (p.decouple >= total(spec)) out.push({ level: 'block', code: st.code, text: `Decouple ${p.decouple} at ${st.name}: the train has only ${total(spec)} coaches or wagons.` });
      else {
        let left = p.decouple;
        for (let i = spec.coaches.length - 1; i >= 0 && left > 0; i--) { const n = Math.min(left, spec.coaches[i].count); spec.coaches[i].count -= n; left -= n; }
        spec.coaches = spec.coaches.filter(c => c.count > 0);
      }
    }
    if (p.couple?.length) for (const c of p.couple) if (c.count > 0) spec.coaches.push({ ...c });
    const size = trainSize(spec, locos, coaches);
    if (size.lengthM > st.platformLengthM + 1 && (st.code !== j.from || p.stop)) out.push({ level: 'warn', code: st.code, text: `Train too long for the platforms at ${st.name} (${Math.round(size.lengthM)} m, platforms ${st.platformLengthM} m).` });
  }
  return out;
}

/** Is it a goods train (wagons, no passenger coaches)? */
export function goodsTrain(spec: ConsistSpec, coaches: Record<string, CoachData>) {
  // (freight stock: wagons of any kind, a covered wagon without windows too)
  const groups = spec.coaches.filter(c => c.count > 0);
  return groups.length > 0 && groups.every(c => isFreightStock(coaches[c.type]));
}

/**
 * The goods line a journey's train can be routed into at a station (StationProfile): one on the side of the
 * journey's running line (journeys run Down, toward increasing km of their built route; a leg taken the other
 * way is mirrored, so a yard is on this side or the other by the way the train goes). Undefined: none usable.
 */
export function goodsLineFor(s: { lines: { id: string; offset: number; role?: string }[] }) {
  return s.lines.find(l => l.role === 'goods' && l.offset < 0)?.id;
}
/** Where a goods train can load or unload in a journey: at its start, at a terminal's yards, and at a goods yard on its side. */
export const canWorkGoods = (j: Journey, s: { code: string; type: string; lines: { id: string; offset: number; role?: string }[] }) =>
  s.code === j.from || s.type === 'terminal' || !!goodsLineFor(s);

/** The work at a stop when the plan does not say: passengers board everywhere; goods load at the start (if empty), no work on the way. */
export function stopWork(j: Journey, s: JourneyStop, goods: boolean): WorkKind[] {
  if (s.work) return s.work;
  if (!goods) return ['board'];
  return s.code === j.from && j.consist.loaded === false ? ['load'] : [];
}

/** The journey as a scenario (no scoring): the built route, start platform, the planned stops (and their work), the end. */
export function journeyScenario(j: Journey, route: RouteData, coaches: Record<string, CoachData> = {}): ScenarioData {
  const st = journeyStations(route, j.from, j.to), first = st[0];
  // the planned stops (a junction too can be passed); the start is a stop too (its platform work: boarding or
  // loading before leaving)
  const goods = goodsTrain(j.consist, coaches);
  const timetable: TimetableEntry[] = st.map(x => ({ x, p: j.stops.find(s => s.code === x.code) }))
    .filter(({ x, p }) => p?.stop || x.code === j.from)
    .map(({ x, p }) => {
      const work = stopWork(j, p ?? { code: x.code, stop: true, dwellS: 120 }, goods);
      // loading or unloading on the way, at a goods yard: routed into its goods line (the start: at its platform)
      const yard = goods && x.code !== j.from && work.some(w => w === 'load' || w === 'unload') ? goodsLineFor(x) : undefined;
      return { station: x.code, dwellS: p?.dwellS ?? 120, work, ...(yard ? { line: yard } : {}) };
    });
  return {
    id: 'route-mode', name: `Journey: ${route.name}`, difficulty: 'Journey', description: 'Route Mode journey',
    route: route.id, start: { km: first.km, atPlatform: first.code, track: 'DOWN' },
    consist: j.consist, time: j.time, timeScale: 1, weather: j.weather,
    timetable, aiTrains: [], endStation: j.to, rules: false,
  };
}
