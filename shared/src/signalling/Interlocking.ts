import type { StationInfo } from '../track/Route';
import type { Switch, TrackGraph } from '../track/TrackGraph';
import type { Occupant } from './Signal';

/**
 * Route setting and locking for each station. A signal may only clear for a
 * route whose switches are set, detected (finished moving) and locked, and
 * whose berthing line is clear. Reception (home -> platform line) and
 * departure (starter -> advanced starter) routes are separate, so a train can
 * be received on the main while another waits to leave from a loop.
 *
 * Each running direction has its own Interlocking; points shared by both
 * (crossovers) carry their locks on the shared Points, so a route set by one
 * direction blocks a conflicting route from the other.
 */
export interface StationRoute {
  trainId: string;
  station: StationInfo;
  lineId: string;
  kind: 'reception' | 'departure';
  needs: { sw: Switch; state: 'normal' | 'reverse' }[];
  set: boolean;
  callingOn: boolean;
  /** lock key on the points: unique per route */
  key: string;
}

/** Points only move when no train is on them or within this distance (km) of them. */
export const POINTS_CLEAR_KM = 0.15;

export class Interlocking {
  readonly routes: StationRoute[] = [];

  /** `runningOffset`: the offset of this direction's running line (0 on a single line). */
  constructor(private graph: TrackGraph, private runningOffset = 0) {}

  private stationSwitches(st: StationInfo) {
    return this.graph.switches.filter(s => s.def.station === st.code);
  }

  /**
   * Switch positions required for a route into (reception) or out of
   * (departure) a line. `crossTo`: the id of a crossover to take on departure
   * (the train changes to the other running line); every other crossover must
   * lie normal.
   */
  requirements(st: StationInfo, lineId: string, kind: 'reception' | 'departure', crossTo?: string) {
    const needs: StationRoute['needs'] = [];
    for (const sw of this.stationSwitches(st)) {
      const id = sw.def.id;
      if (sw.def.kind === 'crossover') { needs.push({ sw, state: kind === 'departure' && id === crossTo ? 'reverse' : 'normal' }); continue; }
      const isEntry = id.endsWith('-E');
      if ((kind === 'reception') !== isEntry) continue;
      const forLine = id === `${st.code}-${lineId}-${isEntry ? 'E' : 'X'}`;
      needs.push({ sw, state: forLine ? 'reverse' : 'normal' });
    }
    return needs;
  }

  lineOffset(st: StationInfo, lineId: string) {
    return st.lineInfo.find(l => l.id === lineId)?.offset ?? this.runningOffset;
  }

  /** Is the platform section of a line free of other trains? */
  lineClear(st: StationInfo, lineId: string, occupants: Occupant[], exceptId: string) {
    const off = this.lineOffset(st, lineId);
    const a = st.entryKm, b = st.exitKm;
    for (const o of occupants) {
      if (o.id === exceptId) continue;
      for (let km = o.tailKm; km <= o.headKm + 1e-9; km += 0.02) {
        if (km > a && km < b && Math.abs(o.offsetAt(km) - off) < 2) return false;
      }
    }
    return true;
  }

  /**
   * Can every switch that has to change position move now? Not while any
   * train stands on it, nor while a train is running toward it within
   * POINTS_CLEAR_KM (it could reach moving points). A train standing short of
   * the points is fine: its signal stays red until they are set and locked.
   * Switches already lying right are never a problem.
   */
  private pointsMovable(needs: StationRoute['needs'], occupants: Occupant[]) {
    for (const n of needs) {
      if (n.sw.state === n.state) continue;
      const d = n.sw.def;
      const lo = Math.min(d.from, d.to) - 2.5, hi = Math.max(d.from, d.to) + 2.5;
      const a = d.rampStart - 0.02, b = d.rampEnd + 0.02;
      for (const o of occupants) {
        const moving = Math.abs((o as { speed?: number }).speed ?? 0) > 0.5;
        if (moving && o.headKm < a && o.headKm > a - POINTS_CLEAR_KM && Math.abs(o.offsetAt(o.headKm) - (d.from + d.to) / 2) < hi - lo) return false;
        if (o.headKm < a || o.tailKm > b) continue;
        for (let km = Math.max(o.tailKm, a); km <= Math.min(o.headKm, b) + 1e-9; km += 0.01) {
          const off = o.offsetAt(km);
          if (off > lo && off < hi) return false;
        }
      }
    }
    return true;
  }

  /** Points locked by another train's route in a different position. */
  private conflicts(needs: StationRoute['needs'], trainId: string) {
    return needs.some(n => n.sw.state !== n.state && [...n.sw.points.holders].some(h => !h.startsWith(`${trainId}|`)));
  }

  find(trainId: string, st: StationInfo, kind: 'reception' | 'departure') {
    return this.routes.find(r => r.trainId === trainId && r.station === st && r.kind === kind);
  }

  private establish(trainId: string, st: StationInfo, lineId: string, kind: 'reception' | 'departure', callingOn: boolean, occupants: Occupant[], crossTo?: string) {
    const needs = this.requirements(st, lineId, kind, crossTo);
    if (this.conflicts(needs, trainId) || !this.pointsMovable(needs, occupants)) return null;
    const key = `${trainId}|${st.code}|${kind}`;
    for (const n of needs) { n.sw.state = n.state; n.sw.lock(key); }
    const r: StationRoute = { trainId, station: st, lineId, kind, needs, set: false, callingOn, key };
    this.routes.push(r);
    return r;
  }

  /** Try to receive a train, preferring `prefs` lines in order. */
  requestReception(trainId: string, st: StationInfo, prefs: string[], occupants: Occupant[]) {
    const existing = this.find(trainId, st, 'reception');
    if (existing) return existing;
    // only one reception at a time per station (single home signal)
    if (this.routes.some(r => r.station === st && r.kind === 'reception')) return null;
    const order = [...prefs, ...st.lineInfo.map(l => l.id).filter(id => !prefs.includes(id))];
    for (const lineId of order) {
      if (!st.lineInfo.some(l => l.id === lineId)) continue;
      if (!this.lineClear(st, lineId, occupants, trainId)) continue;
      const r = this.establish(trainId, st, lineId, 'reception', false, occupants);
      if (r) return r;
    }
    return null;
  }

  /** Calling-on: admit a train into an occupied line at caution. */
  requestCallingOn(trainId: string, st: StationInfo, lineId: string, occupants: Occupant[] = []) {
    if (this.routes.some(r => r.station === st && r.kind === 'reception')) return null;
    return this.establish(trainId, st, lineId, 'reception', true, occupants);
  }

  /** Departure route; `crossTo` names a crossover to take onto the other running line. */
  requestDeparture(trainId: string, st: StationInfo, lineId: string, crossTo?: string, occupants: Occupant[] = []) {
    return this.find(trainId, st, 'departure') ?? this.establish(trainId, st, lineId, 'departure', false, occupants, crossTo);
  }

  /** Cancel one route (its points unlock; free points go back to normal). */
  release(r: StationRoute) {
    this.routes.splice(this.routes.indexOf(r), 1);
    for (const n of r.needs) {
      n.sw.unlock(r.key);
      if (!n.sw.locked) n.sw.state = 'normal';
    }
  }

  /** Cancel every route held by a train (e.g. AI despawn, teleport). */
  releaseTrain(trainId: string) {
    for (const r of this.routes.filter(r => r.trainId === trainId)) this.release(r);
  }

  update(dt: number, occupants: Occupant[]) {
    for (const sw of this.graph.switches) sw.update(dt);
    for (const r of [...this.routes]) {
      r.set = r.needs.every(n => n.sw.state === n.state && !n.sw.moving);
      const occ = occupants.find(o => o.id === r.trainId);
      if (!occ) { this.release(r); continue; }
      // sectional route release once the tail has cleared the switches
      const clearKm = r.kind === 'reception' ? r.station.entryKm + 0.11 : r.station.exitKm + 0.01;
      if (occ.tailKm > clearKm) this.release(r);
    }
  }

  // ---- queries used by the block system ----
  reception(st: StationInfo) { return this.routes.find(r => r.station === st && r.kind === 'reception'); }
  departure(st: StationInfo, lineId: string) { return this.routes.find(r => r.station === st && r.kind === 'departure' && r.lineId === lineId); }
}
