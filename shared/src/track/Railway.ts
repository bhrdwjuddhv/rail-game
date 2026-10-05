import { Alignment } from './Chainage';
import { formatGradient, parseGradient } from './Gradient';
import { CrossoverData, RegionData, Route, RouteData } from './Route';
import { LineDef, Switch, SwitchDef } from './TrackGraph';

/**
 * Route data as seen from the far end: every chainage becomes L - km, every
 * lateral offset changes sign, ranges are swapped, and lists come out in
 * ascending km again. Compiling this gives the Up direction's view.
 */
export function mirrorRouteData(d: RouteData, L: number): RouteData {
  const km = (k: number) => +(L - k).toFixed(6);
  const range = <T extends { fromKm: number; toKm: number }>(r: T): T => ({ ...r, fromKm: km(r.toKm), toKm: km(r.fromKm) });
  const byKm = <T>(a: T[], k: (x: T) => number) => [...a].sort((x, y) => k(x) - k(y));
  // a crossover ramp from A (low km) to B (high km) is, from the far end, a ramp from B to A
  const xo = (c: CrossoverData): CrossoverData => ({ km: +(km(c.km) - 0.1).toFixed(6), fromLine: c.toLine, toLine: c.fromLine });
  const prof = [...d.profile].sort((a, b) => a.km - b.km);
  const profile = prof.map((p, i) => {
    const end = i + 1 < prof.length ? prof[i + 1].km : L;
    const g = -parseGradient(p.gradient);
    return { km: Math.max(0, km(end)), gradient: g === 0 ? 'level' : formatGradient(g) };
  }).reverse();
  return {
    ...d,
    segments: [...d.segments].reverse().map(s => (s.direction ? { ...s, direction: s.direction === 'left' ? 'right' : 'left' } : { ...s })),
    profile,
    regions: byKm(d.regions.map(range), r => r.fromKm),
    stations: byKm(d.stations.map(s => ({
      ...s, km: km(s.km), buildingSide: (-s.buildingSide) as 1 | -1,
      lines: s.lines.map(l => ({ ...l, offset: -l.offset })),
      platforms: s.platforms.map(p => ({ ...p, from: -p.from, to: -p.to })),
      crossovers: s.crossovers?.map(xo),
    })), s => s.km),
    signals: byKm(d.signals.map(s => ({ ...s, km: km(s.km), offset: s.offset === undefined ? undefined : -s.offset })), s => s.km),
    speedLimits: byKm(d.speedLimits.map(range), r => r.fromKm),
    structures: byKm(d.structures.map(range), r => r.fromKm),
    levelCrossings: byKm(d.levelCrossings.map(l => ({ ...l, km: km(l.km) })), l => l.km),
    scenery: byKm(d.scenery.map(z => ({ ...range(z), roadOffset: z.roadOffset === undefined ? undefined : -z.roadOffset })), z => z.fromKm),
    features: byKm(d.features.map(f => ({ ...f, km: km(f.km) })), f => f.km),
    crossovers: d.crossovers?.map(xo),
  };
}

/** A switch definition expressed in the other view's coordinates. */
export function mirrorSwitchDef(d: SwitchDef, L: number): SwitchDef {
  return {
    ...d, kind: d.kind === 'facing' ? 'trailing' : d.kind === 'trailing' ? 'facing' : 'crossover',
    from: -d.to, to: -d.from, rampStart: +(L - d.rampEnd).toFixed(6), rampEnd: +(L - d.rampStart).toFixed(6),
  };
}

/**
 * A route with all its direction views. `main` is the surveyed (+km) view: the
 * world is built from it. On a double line `views` holds DOWN (= main) and UP
 * (the mirror); crossovers exist in both and share their point machine.
 */
export class Railway {
  readonly main: Route;
  readonly views: Route[];
  readonly lengthKm: number;
  /** every line and switch of both directions in surveyed coordinates, for building track */
  readonly layout: { lines: LineDef[]; switches: Switch[] };

  constructor(data: RouteData, regions: Record<string, RegionData>) {
    this.main = new Route(data, regions);
    this.lengthKm = this.main.lengthKm;
    this.views = [this.main];
    const lines = [...this.main.graph.lines];
    const switches = [...this.main.graph.switches];
    if (this.main.double) {
      const al = Alignment.mirrored(this.main.alignment);
      const L = al.length / 1000;
      const up = new Route(mirrorRouteData(data, L), regions, { mirrored: true, alignment: al, running: 'UP' });
      // crossovers: one set of points seen from both directions, moved by the Down interlocking
      for (const sw of up.graph.switches) {
        if (sw.def.kind !== 'crossover') continue;
        const twin = this.main.graph.byId.get(sw.def.id);
        if (!twin) continue;
        const i = up.graph.switches.indexOf(sw);
        const shared = new Switch(sw.def, twin.points, false);
        up.graph.switches[i] = shared;
        up.graph.byId.set(sw.def.id, shared);
      }
      for (const l of up.graph.lines) if (!lines.some(x => x.id === l.id)) lines.push({ ...l, offset: -l.offset, fromKm: L - l.toKm, toKm: L - l.fromKm });
      for (const sw of up.graph.switches) if (sw.primary) switches.push(new Switch(mirrorSwitchDef(sw.def, L), sw.points, false));
      this.views.push(up);
    }
    this.layout = { lines, switches };
  }

  get double() { return this.main.double; }
  view(lineId: string) { return this.views.find(v => v.running.id === lineId) ?? this.main; }
  /** km in view `from` expressed in view `to` */
  convertKm(km: number, from: Route, to: Route) { return from === to ? km : to.viewKm(from.canonicalKm(km)); }
}
