import type { Aspect } from '../events';
import type { Route } from '../track/Route';
import { TrackGraph } from '../track/TrackGraph';
import type { Interlocking } from './Interlocking';
import { Occupant, Signal } from './Signal';

export const OVERLAP_KM = 0.12;

/**
 * Automatic block + station signal aspects. Each stop signal protects the
 * track up to the next stop signal on the route currently set (plus an
 * overlap). Aspects step down R <- Y <- YY <- G from the signal ahead.
 */
export class BlockSystem {
  readonly signals: Signal[];
  /** God Mode: every signal shows proceed (AI trains still space themselves by the real occupancy) */
  forceGreen = false;
  private byStation = new Map<string, Signal[]>();

  constructor(private route: Route, private interlocking: Interlocking) {
    this.signals = route.signals.map(d => new Signal(d));
    for (const s of this.signals) {
      if (!s.def.station) continue;
      const list = this.byStation.get(s.def.station) ?? [];
      list.push(s);
      this.byStation.set(s.def.station, list);
    }
  }

  get(id: string) { return this.signals.find(s => s.id === id); }

  /** Lateral offset of the route set from (km, offset) forward. */
  pathFn(km: number, offset: number, toKm: number) {
    const { ramps } = this.route.graph.followForward(km, offset, toKm);
    return (k: number) => TrackGraph.offsetFromRamps(offset, ramps, k);
  }

  /** First signal (optionally stop-only) ahead of (km, offset) along the set route. */
  nextSignal(km: number, offset: number, stopOnly: boolean, pathOffset?: (k: number) => number): Signal | null {
    const path = pathOffset ?? this.pathFn(km, offset, km + 30);
    for (const s of this.signals) {
      if (s.km <= km + 1e-6) continue;
      if (stopOnly && !s.isStop) continue;
      if (Math.abs(path(s.km) - s.def.offset) < 0.5) return s;
    }
    return null;
  }

  private sectionOccupied(fromKm: number, toKm: number, path: (k: number) => number, occupants: Occupant[]) {
    for (const o of occupants) {
      if (o.headKm <= fromKm || o.tailKm > toKm) continue;
      const a = Math.max(o.tailKm, fromKm + 1e-4), b = Math.min(o.headKm, toKm);
      for (let km = a; km <= b + 1e-9; km += 0.02) {
        if (Math.abs(o.offsetAt(km) - path(km)) < 2) return true;
      }
      if (Math.abs(o.offsetAt(b) - path(b)) < 2) return true;
    }
    return false;
  }

  /**
   * Points detection: a stop signal cannot clear over points in its section
   * that are moving, or lie reversed without a locked route (e.g. a crossover
   * thrown with no move set). The path ahead follows the points as they lie.
   */
  private pointsUnsafe(fromKm: number, toKm: number, path: (k: number) => number) {
    for (const sw of this.route.graph.switches) {
      const d = sw.def;
      if (d.rampEnd <= fromKm || d.rampStart >= toKm) continue;
      const onPath = Math.abs(path(d.rampStart) - d.from) < 0.5 || Math.abs(path(d.rampEnd) - d.to) < 0.5;
      if (!onPath) continue;
      if (sw.moving || (sw.state === 'reverse' && !sw.locked)) return true;
    }
    return false;
  }

  private allowed(s: Signal) {
    const st = s.def.station ? this.route.station(s.def.station) : undefined;
    if (!st) return true;
    switch (s.def.kind) {
      case 'home': {
        const r = this.interlocking.reception(st);
        return !!r && r.set && !r.callingOn;
      }
      case 'starter': {
        if (st.type === 'terminal') return false;
        const r = this.interlocking.departure(st, s.def.line!);
        return !!r && r.set;
      }
      default: return true;
    }
  }

  update(occupants: Occupant[]) {
    const end = this.route.lengthKm;
    // far-to-near so each signal sees the fresh aspect of the one ahead
    for (let i = this.signals.length - 1; i >= 0; i--) {
      const s = this.signals[i];
      const path = this.pathFn(s.km, s.def.offset, s.km + 8);
      const next = this.nextSignal(s.km, s.def.offset, true, path);
      if (this.forceGreen) { s.aspect = 'G'; s.callingOn = false; continue; }
      if (!s.isStop) {
        s.aspect = !next || next.aspect === 'R' ? 'Y' : next.aspect === 'Y' ? 'YY' : 'G';
        continue;
      }
      let aspect: Aspect;
      const until = next ? Math.min(end, next.km + OVERLAP_KM) : end;
      if (!this.allowed(s)) aspect = 'R';
      else if (this.pointsUnsafe(s.km, until, path)) aspect = 'R';
      else if (this.sectionOccupied(s.km, until, path, occupants)) aspect = 'R';
      else if (!next) aspect = 'Y';
      else aspect = next.aspect === 'R' ? 'Y' : next.aspect === 'Y' && s.def.aspects === 4 ? 'YY' : 'G';
      s.aspect = aspect;

      if (s.def.kind === 'home') {
        const st = this.route.station(s.def.station!)!;
        const r = this.interlocking.reception(st);
        s.callingOn = !!r && r.set && r.callingOn;
        const pf = r && r.set && r.lineId !== this.route.running.id ? st.platforms.find(p => p.lines.includes(r.lineId)) : undefined;
        s.routeIndicator = s.def.routeIndicator && pf ? pf.num : null;
      }
    }
  }

  stationSignals(code: string) { return this.byStation.get(code) ?? []; }
}
