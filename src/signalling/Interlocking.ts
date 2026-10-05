import type { StationInfo } from '../track/Route';
import type { Switch, TrackGraph } from '../track/TrackGraph';
import type { Occupant } from './Signal';

/**
 * Route setting and locking for each station. A signal may only clear for a
 * route whose switches are set, detected (finished moving) and locked, and
 * whose berthing line is clear. Reception (home -> platform line) and
 * departure (starter -> advanced starter) routes are separate, so a train can
 * be received on the main while another waits to leave from a loop.
 */
export interface StationRoute {
  trainId: string;
  station: StationInfo;
  lineId: string;
  kind: 'reception' | 'departure';
  needs: { sw: Switch; state: 'normal' | 'reverse' }[];
  set: boolean;
  callingOn: boolean;
}

export class Interlocking {
  readonly routes: StationRoute[] = [];

  constructor(private graph: TrackGraph) {}

  private stationSwitches(st: StationInfo) {
    return this.graph.switches.filter(s => s.def.station === st.code);
  }

  /** Switch positions required for a route into (reception) or out of (departure) a line. */
  requirements(st: StationInfo, lineId: string, kind: 'reception' | 'departure') {
    const needs: StationRoute['needs'] = [];
    for (const sw of this.stationSwitches(st)) {
      const id = sw.def.id;
      if (sw.def.kind === 'crossover') { needs.push({ sw, state: 'normal' }); continue; }
      const isEntry = id.endsWith('-E');
      if ((kind === 'reception') !== isEntry) continue;
      const forLine = id === `${st.code}-${lineId}-${isEntry ? 'E' : 'X'}`;
      needs.push({ sw, state: forLine ? 'reverse' : 'normal' });
    }
    return needs;
  }

  lineOffset(st: StationInfo, lineId: string) {
    return st.lineInfo.find(l => l.id === lineId)?.offset ?? 0;
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

  private conflicts(needs: StationRoute['needs'], trainId: string) {
    return needs.some(n => n.sw.locked && n.sw.state !== n.state && !this.routes.some(r => r.trainId === trainId && r.needs.some(m => m.sw === n.sw)));
  }

  find(trainId: string, st: StationInfo, kind: 'reception' | 'departure') {
    return this.routes.find(r => r.trainId === trainId && r.station === st && r.kind === kind);
  }

  private establish(trainId: string, st: StationInfo, lineId: string, kind: 'reception' | 'departure', callingOn: boolean) {
    const needs = this.requirements(st, lineId, kind);
    if (this.conflicts(needs, trainId)) return null;
    for (const n of needs) { n.sw.state = n.state; n.sw.locked = true; }
    const r: StationRoute = { trainId, station: st, lineId, kind, needs, set: false, callingOn };
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
      if (!this.lineClear(st, lineId, occupants, trainId)) continue;
      const r = this.establish(trainId, st, lineId, 'reception', false);
      if (r) return r;
    }
    return null;
  }

  /** Calling-on: admit a train into an occupied line at caution. */
  requestCallingOn(trainId: string, st: StationInfo, lineId: string) {
    if (this.routes.some(r => r.station === st && r.kind === 'reception')) return null;
    return this.establish(trainId, st, lineId, 'reception', true);
  }

  requestDeparture(trainId: string, st: StationInfo, lineId: string) {
    return this.find(trainId, st, 'departure') ?? this.establish(trainId, st, lineId, 'departure', false);
  }

  private release(r: StationRoute) {
    this.routes.splice(this.routes.indexOf(r), 1);
    for (const n of r.needs) {
      if (this.routes.some(o => o.needs.some(m => m.sw === n.sw))) continue;
      n.sw.locked = false;
      n.sw.state = 'normal';
    }
  }

  /** Cancel every route held by a train (e.g. AI despawn). */
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
