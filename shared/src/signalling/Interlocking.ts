import { MIDDLE_LINE, type StationInfo } from '../track/Route';
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
/**
 * The middle line, shared by both directions, one train at a time: each
 * station's stretch of it (key: station code) and each section between two
 * stations (key: sec:CODE|CODE). Value: the train holding it, in the view
 * (interlocking) that claimed it; `to`: a section's far station, in that view.
 */
export type MiddleClaims = Map<string, { trainId: string; st: StationInfo; owner: Interlocking; to?: StationInfo }>;

/** where a route comes from / goes to on the middle line */
export interface MiddleRoute {
  /** reception of a train arriving along the middle line (its own home signal) */
  fromMiddle?: boolean;
  /** departure onto the middle line toward the next station (the section is claimed) */
  viaMiddle?: boolean;
  /** with viaMiddle: the station at the far end of the section */
  to?: StationInfo;
}

const sectionKey = (a: StationInfo, b: StationInfo) => `sec:${[a.code, b.code].sort().join('|')}`;

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
  fromMiddle?: boolean;
  viaMiddle?: boolean;
}

/** Points only move when no train is on them or within this distance (km) of them. */
export const POINTS_CLEAR_KM = 0.15;

export class Interlocking {
  readonly routes: StationRoute[] = [];

  /**
   * `runningOffset`: the offset of this direction's running line (0 on a single line).
   * `middle`: who holds each station's middle line, shared by both directions'
   * interlockings (either direction can be routed onto it: one train at a time).
   */
  constructor(private graph: TrackGraph, private runningOffset = 0, private middle: MiddleClaims = new Map()) {}

  private stationSwitches(st: StationInfo) {
    return this.graph.switches.filter(s => s.def.station === st.code);
  }

  /**
   * Switch positions required for a route into (reception) or out of
   * (departure) a line. `crossTo`: the id of a crossover to take on departure
   * (the train changes to the other running line); every other crossover must
   * lie normal.
   */
  requirements(st: StationInfo, lineId: string, kind: 'reception' | 'departure', crossTo?: string, m: MiddleRoute = {}) {
    const needs: StationRoute['needs'] = [];
    const mid = lineId === MIDDLE_LINE;
    for (const sw of this.stationSwitches(st)) {
      const id = sw.def.id;
      if (sw.def.kind === 'crossover') { needs.push({ sw, state: kind === 'departure' && id === crossTo && !m.viaMiddle ? 'reverse' : 'normal' }); continue; }
      // <code>-<line>-E / -X: into / out of a station line; <code>-ML-I / -O: in from / out onto the middle line
      const suffix = id.slice(id.lastIndexOf('-') + 1), line = id.slice(st.code.length + 1, id.lastIndexOf('-'));
      // a big junction's ladder: every step up to the line's own is taken (the diagonal), the rest lie
      // normal; so two departures merging on the same ladder always disagree on a switch and never both set
      const chain = kind === 'reception' ? (suffix === 'E' ? st.ladderIn : undefined) : (suffix === 'X' ? st.ladderOut : undefined);
      if (chain?.includes(line)) {
        const ti = chain.indexOf(lineId);
        needs.push({ sw, state: ti >= 0 && chain.indexOf(line) <= ti ? 'reverse' : 'normal' });
        continue;
      }
      let reverse: boolean;
      if (kind === 'reception') {
        if (suffix === 'E') reverse = line === lineId && !(m.fromMiddle && mid);
        else if (suffix === 'I') reverse = !!m.fromMiddle && !mid;
        else continue;
      } else {
        if (suffix === 'X') reverse = line === lineId && !(m.viaMiddle && mid);
        else if (suffix === 'O') reverse = !!m.viaMiddle && !mid;
        else continue;
      }
      needs.push({ sw, state: reverse ? 'reverse' : 'normal' });
    }
    return needs;
  }

  lineOffset(st: StationInfo, lineId: string) {
    return st.lineInfo.find(l => l.id === lineId)?.offset ?? this.runningOffset;
  }

  /** Is the platform section of a line free of other trains? */
  lineClear(st: StationInfo, lineId: string, occupants: Occupant[], exceptId: string) {
    const off = this.lineOffset(st, lineId);
    // only the line's own length (a junction's two bay halves share an offset)
    const li = st.lineInfo.find(l => l.id === lineId);
    const a = Math.max(st.entryKm, li?.fromKm ?? -Infinity), b = Math.min(st.exitKm, li?.toKm ?? Infinity);
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

  private establish(trainId: string, st: StationInfo, lineId: string, kind: 'reception' | 'departure', callingOn: boolean, occupants: Occupant[], crossTo?: string, m: MiddleRoute = {}) {
    const needs = this.requirements(st, lineId, kind, crossTo, m);
    if (this.conflicts(needs, trainId) || !this.pointsMovable(needs, occupants)) return null;
    const key = `${trainId}|${st.code}|${kind}`;
    // a section of the middle line: one train at a time, whichever direction
    if (kind === 'departure' && m.viaMiddle) {
      if (!m.to) return null;
      const k = sectionKey(st, m.to), holder = this.middle.get(k);
      if (holder && holder.trainId !== trainId) return null;
      this.middle.set(k, { trainId, st, owner: this, to: m.to });
    }
    // the middle line is shared with the other direction: claimed until this train has left it
    if (kind === 'reception' && lineId === MIDDLE_LINE) {
      const holder = this.middle.get(st.code);
      if (holder && holder.trainId !== trainId) return null;
      this.middle.set(st.code, { trainId, st, owner: this });
    }
    for (const n of needs) { n.sw.state = n.state; n.sw.lock(key); }
    const r: StationRoute = { trainId, station: st, lineId, kind, needs, set: false, callingOn, key, fromMiddle: m.fromMiddle, viaMiddle: m.viaMiddle };
    this.routes.push(r);
    return r;
  }

  /**
   * Try to receive a train, preferring `prefs` lines in order (`only`: none but those); `fromMiddle`: it
   * comes along the middle line.
   */
  requestReception(trainId: string, st: StationInfo, prefs: string[], occupants: Occupant[], fromMiddle = false, only = false) {
    const existing = this.find(trainId, st, 'reception');
    if (existing) return existing;
    // only one reception at a time per station (single home signal)
    if (this.routes.some(r => r.station === st && r.kind === 'reception')) return null;
    const order = only ? prefs : [...prefs, ...st.lineInfo.map(l => l.id).filter(id => !prefs.includes(id))];
    for (const lineId of order) {
      if (!st.lineInfo.some(l => l.id === lineId)) continue;
      if (!this.lineClear(st, lineId, occupants, trainId)) continue;
      const r = this.establish(trainId, st, lineId, 'reception', false, occupants, undefined, { fromMiddle });
      if (r) return r;
    }
    return null;
  }

  /** Calling-on: admit a train into an occupied line at caution. */
  requestCallingOn(trainId: string, st: StationInfo, lineId: string, occupants: Occupant[] = [], fromMiddle = false) {
    if (this.routes.some(r => r.station === st && r.kind === 'reception')) return null;
    return this.establish(trainId, st, lineId, 'reception', true, occupants, undefined, { fromMiddle });
  }

  /**
   * Departure route; `crossTo` names a crossover to take onto the other running
   * line; `m.viaMiddle`: onto the middle line to the next station (`m.to`).
   */
  requestDeparture(trainId: string, st: StationInfo, lineId: string, crossTo?: string, occupants: Occupant[] = [], m: MiddleRoute = {}) {
    return this.find(trainId, st, 'departure') ?? this.establish(trainId, st, lineId, 'departure', false, occupants, crossTo, m);
  }

  /** Is this section of the middle line (from `st` to `to`) free to claim for `trainId`? */
  sectionFree(st: StationInfo, to: StationInfo, trainId: string) {
    const h = this.middle.get(sectionKey(st, to));
    return !h || h.trainId === trainId;
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
      // (a departure onto the middle line holds until the tail is past its O turnout, just beyond the exit)
      const outEnd = r.needs.find(n => n.state === 'reverse' && n.sw.def.id.endsWith('-O'))?.sw.def.rampEnd;
      // a reception holds until the tail has cleared the last points it uses (a junction's ladder is far inside its limits)
      const inEnd = Math.max(0, ...r.needs.filter(n => n.state === 'reverse').map(n => n.sw.def.rampEnd));
      const clearKm = r.kind === 'reception' ? Math.max(r.station.entryKm + 0.11, inEnd + 0.01) : Math.max(r.station.exitKm, outEnd ?? 0) + 0.01;
      if (occ.tailKm > clearKm) this.release(r);
    }
    // a middle line claim (this direction's) ends once its train has no route there and is off that stretch of
    // the middle line (a station's, or a section's between stations)
    for (const [code, c] of this.middle) {
      if (c.owner !== this) continue;
      const occ = occupants.find(o => o.id === c.trainId);
      if (!occ) { this.middle.delete(code); continue; }
      if (this.routes.some(r => r.trainId === c.trainId && r.station === c.st)) continue;
      const a = Math.max(occ.tailKm, c.to ? c.st.exitKm - 0.15 : c.st.entryKm - 0.2), b = Math.min(occ.headKm, c.to ? c.to.entryKm : c.st.exitKm + 0.2);
      let on = false;
      for (let km = a; km <= b + 1e-9; km += 0.02) if (Math.abs(occ.offsetAt(km)) < 1) { on = true; break; }
      if (!on) this.middle.delete(code);
    }
  }

  // ---- queries used by the block system ----
  reception(st: StationInfo) { return this.routes.find(r => r.station === st && r.kind === 'reception'); }
  departure(st: StationInfo, lineId: string) { return this.routes.find(r => r.station === st && r.kind === 'departure' && r.lineId === lineId); }
}
