import { smoothstep } from '../util';

/**
 * Track topology. The route has one or two running lines (a single line at
 * offset 0, or Up and Down either side of the centreline); other lines (station
 * loops) sit at a constant lateral offset. Switches connect two offsets via a
 * lateral "ramp" (the turnout curve). This keeps every track position a simple
 * pair (km along route, lateral offset) while still giving real facing and
 * trailing turnouts, loop lines and crossovers.
 */

export const RAMP_M = 100;
const EPS = 0.3;

export interface LineDef { id: string; station?: string; offset: number; fromKm: number; toKm: number }

export interface SwitchDef {
  id: string;
  station?: string;
  kind: 'facing' | 'trailing' | 'crossover';
  from: number; // offset the ramp starts on (low km side)
  to: number;   // offset the ramp ends on (high km side)
  rampStart: number; // km
  rampEnd: number;   // km
}

/** The physical point machine: shared by every view of the same switch (Up and Down routes see one set of points). */
export interface Points {
  state: 'normal' | 'reverse';
  /** 0 = normal, 1 = reverse; animated by the owning interlocking */
  throw: number;
  /** keys of the routes holding the points locked */
  holders: Set<string>;
}

export class Switch {
  /**
   * `primary` = this view animates the points. A mirrored view (or a render
   * copy) shares the same Points but never steps them, so they move once.
   */
  constructor(readonly def: SwitchDef, readonly points: Points = { state: 'normal', throw: 0, holders: new Set() }, readonly primary = true) {}
  get state() { return this.points.state; }
  set state(s: 'normal' | 'reverse') { this.points.state = s; }
  get throw() { return this.points.throw; }
  get locked() { return this.points.holders.size > 0; }
  lock(key: string) { this.points.holders.add(key); }
  unlock(key: string) { this.points.holders.delete(key); }
  get moving() { return Math.abs(this.points.throw - (this.points.state === 'reverse' ? 1 : 0)) > 1e-3; }
  update(dt: number) {
    if (!this.primary) return;
    const p = this.points;
    const target = p.state === 'reverse' ? 1 : 0;
    const d = target - p.throw;
    const step = dt / 3.5; // ~3.5 s for the point machine
    p.throw = Math.abs(d) <= step ? target : p.throw + Math.sign(d) * step;
  }
}

export interface Ramp { start: number; end: number; from: number; to: number; switchId: string }

export interface RunningLine { id: string; offset: number }

export class TrackGraph {
  readonly lines: LineDef[] = [];
  readonly switches: Switch[] = [];
  readonly byId = new Map<string, Switch>();

  constructor(readonly lengthKm: number, running: RunningLine[] = [{ id: 'main', offset: 0 }]) {
    for (const r of running) this.lines.push({ id: r.id, offset: r.offset, fromKm: 0, toKm: lengthKm });
  }

  addLine(l: LineDef) { this.lines.push(l); }

  addSwitch(d: SwitchDef, points?: Points, primary = true) {
    const s = new Switch(d, points, primary);
    this.switches.push(s);
    this.byId.set(d.id, s);
    this.switches.sort((a, b) => a.def.rampStart - b.def.rampStart);
    return s;
  }

  lineExists(offset: number, km: number) {
    for (const l of this.lines) {
      if (Math.abs(l.offset - offset) < EPS && km >= l.fromKm - 0.0005 && km <= l.toKm + 0.0005) return true;
    }
    return false;
  }

  lineAt(offset: number, km: number): LineDef | undefined {
    return this.lines.find(l => Math.abs(l.offset - offset) < EPS && km >= l.fromKm - 0.001 && km <= l.toKm + 0.001);
  }

  /** Should a train at `offset` moving forward past switch's rampStart take the ramp? */
  takesForward(sw: Switch, offset: number) {
    if (Math.abs(offset - sw.def.from) >= EPS) return false;
    if (!this.lineExists(sw.def.from, sw.def.rampStart + 0.002)) return true; // line ends: must merge
    return sw.state === 'reverse';
  }

  /** Should a train at `offset` moving backward past switch's rampEnd take the ramp? */
  takesBackward(sw: Switch, offset: number) {
    if (Math.abs(offset - sw.def.to) >= EPS) return false;
    if (!this.lineExists(sw.def.to, sw.def.rampEnd - 0.002)) return true;
    return sw.state === 'reverse';
  }

  /**
   * Walk forward from (startKm, startOffset) to endKm using current switch
   * states. Returns the ramps that would be taken and the final offset.
   */
  followForward(startKm: number, startOffset: number, endKm: number) {
    const ramps: Ramp[] = [];
    let offset = startOffset;
    for (const sw of this.switches) {
      if (sw.def.rampStart <= startKm || sw.def.rampStart > endKm) continue;
      if (this.takesForward(sw, offset)) {
        ramps.push({ start: sw.def.rampStart, end: sw.def.rampEnd, from: sw.def.from, to: sw.def.to, switchId: sw.def.id });
        offset = sw.def.to;
      }
    }
    return { ramps, offset };
  }

  static offsetFromRamps(base: number, ramps: Ramp[], km: number) {
    let o = base;
    for (const r of ramps) {
      if (km >= r.end) o = r.to;
      else if (km > r.start) return r.from + (r.to - r.from) * smoothstep(r.start, r.end, km);
      else break;
    }
    return o;
  }
}

/**
 * The path one train has actually taken. Vehicles behind the head look up their
 * lateral offset here, so a train keeps following the route it entered even if
 * the switches move after the head has passed (the interlocking prevents that,
 * but this is what makes it robust).
 */
export class TrackPath {
  ramps: Ramp[] = [];
  private headKm: number;
  private lowKm: number;

  constructor(private graph: TrackGraph, headKm: number, tailKm: number, public baseOffset: number) {
    this.headKm = headKm;
    this.lowKm = tailKm;
  }

  offsetAt(km: number) { return TrackGraph.offsetFromRamps(this.baseOffset, this.ramps, km); }
  get headOffset() { return this.offsetAt(this.headKm); }

  /** Advance to the new head/tail; returns ids of switches whose toes were passed by the head. */
  update(headKm: number, tailKm: number): string[] {
    const crossed: string[] = [];
    if (headKm > this.headKm) {
      for (const sw of this.graph.switches) {
        const p = sw.def.rampStart;
        if (p <= this.headKm || p > headKm) continue;
        if (this.ramps.some(r => r.switchId === sw.def.id)) continue;
        const o = this.offsetAt(p - 0.0001);
        if (this.graph.takesForward(sw, o)) {
          this.ramps.push({ start: p, end: sw.def.rampEnd, from: sw.def.from, to: sw.def.to, switchId: sw.def.id });
          this.ramps.sort((a, b) => a.start - b.start);
        }
        crossed.push(sw.def.id);
      }
    }
    if (tailKm < this.lowKm) {
      const sws = this.graph.switches.filter(s => s.def.rampEnd < this.lowKm && s.def.rampEnd >= tailKm)
        .sort((a, b) => b.def.rampEnd - a.def.rampEnd);
      for (const sw of sws) {
        if (this.ramps.some(r => r.switchId === sw.def.id)) continue;
        const o = this.offsetAt(sw.def.rampEnd + 0.0001);
        if (this.graph.takesBackward(sw, o)) {
          // everything below this ramp now starts on sw.from
          this.ramps = this.ramps.filter(r => r.start > sw.def.rampEnd);
          this.ramps.unshift({ start: sw.def.rampStart, end: sw.def.rampEnd, from: sw.def.from, to: sw.def.to, switchId: sw.def.id });
          this.baseOffset = sw.def.from;
        }
        crossed.push(sw.def.id);
      }
      this.lowKm = tailKm;
    }
    this.headKm = headKm;
    // prune ramps fully behind the tail / ahead of the head
    while (this.ramps.length && this.ramps[0].end < tailKm - 0.05) this.baseOffset = this.ramps.shift()!.to;
    while (this.ramps.length && this.ramps[this.ramps.length - 1].start > headKm + 0.05) this.ramps.pop();
    if (tailKm > this.lowKm) this.lowKm = tailKm;
    return crossed;
  }
}
