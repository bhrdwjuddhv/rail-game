import { approach, KMPH } from '../util';
import type { BlockSystem } from '../signalling/BlockSystem';
import type { Occupant } from '../signalling/Signal';
import type { Route } from '../track/Route';
import { TrackPath } from '../track/TrackGraph';
import type { StopPlan, WorkedTrain } from '../gameplay/Timetable';

export type DriveStyle = 'gentle' | 'normal' | 'aggressive';
/** acceleration and service braking (m/s²) of each driving style */
export const STYLES: Record<DriveStyle, { acc: number; dec: number }> = {
  gentle: { acc: 0.2, dec: 0.4 },
  normal: { acc: 0.4, dec: 0.65 },
  aggressive: { acc: 0.75, dec: 1.0 },
};
/** parked: brakes on; auto: drives itself at its cruise speed; speed: holds the set speed */
export type DriveMode = 'parked' | 'auto' | 'speed';

/** A stop on the train's path: head km (in its view) where it stands, and for how long. */
export interface PathStop { km: number; seconds: number; label: string; station?: string }
/** "Slow to X km/h" between two km (view km) */
export interface SlowZone { fromKm: number; toKm: number; kmph: number }

/** keep this far (m) behind any train ahead on the same track, signals or not */
const KEEP_CLEAR_M = 30;
const EMERGENCY = 1.4;

/**
 * A train placed in Record Mode: kinematic like an AI train, but with a
 * driving style, a set speed or auto drive, optional signals and speed limits,
 * and a path (stops, stop markers, slow zones, an end). It never runs into
 * another train: whatever its settings, it stops short of anything on its
 * track ahead (others() gives every train as seen in its view).
 */
export class RecordTrain implements WorkedTrain {
  readonly plan = new Map<string, StopPlan>();
  readonly path: TrackPath;
  headKm: number;
  speed = 0;
  gone = false;
  mode: DriveMode = 'auto';
  /** set speed (mode 'speed') or cruise speed (mode 'auto'), km/h */
  kmph: number;
  style: DriveStyle = 'normal';
  obeySignals = true;
  obeyLimits = true;
  stops: PathStop[] = [];
  slow: SlowZone[] = [];
  /** the path ends here (head km); null: runs to the end of the line */
  endKm: number | null = null;
  /** the head stood at endKm (the owner decides what comes next) */
  ended = false;
  /** waiting for "Go" */
  held = false;
  /** seconds before it starts ("start after X s") */
  delay = 0;
  /** seconds left at the current stop (-1: not standing at one) */
  dwell = -1;
  /** the stop it last stood at (its station may now give it the starter) */
  private served = new Set<PathStop>();
  /** every train in this view (positions in its km), for keeping clear */
  others: () => Occupant[] = () => [];
  readonly priority: number;
  readonly cruiseKmph: number;

  constructor(readonly id: string, public name: string, readonly length: number, readonly route: Route, private block: BlockSystem,
    headKm: number, offset: number, readonly maxKmph: number, priority = 2) {
    this.headKm = headKm;
    this.kmph = maxKmph;
    this.cruiseKmph = maxKmph;
    this.priority = priority;
    this.path = new TrackPath(route.graph, headKm, this.tailKm, offset);
  }

  get tailKm() { return this.headKm - this.length / 1000; }
  offsetAt(km: number) { return this.path.offsetAt(km); }
  /** standing (or about to) at a stop of its path */
  get atStop() { return this.dwell > 0; }

  /** Its booked stop at `code` is done (the dispatcher's departure gate). */
  doneAt(code: string) {
    const s = this.stops.find(x => x.station === code);
    return !s || (this.served.has(s) && this.dwell <= 0);
  }

  /** Forget which stops were made (the path starts again). */
  resetStops() { this.served.clear(); this.dwell = -1; this.ended = false; }

  /** Target speed (m/s) from everything ahead, and whether an obstacle (not a limit) set it. */
  target(): { v: number; hard: boolean } {
    if (this.mode === 'parked' || this.held || this.delay > 0 || this.dwell > 0 || this.ended) return { v: 0, hard: false };
    const head = this.headKm, off = this.path.offsetAt(head);
    const b = STYLES[this.style].dec * 0.85;
    const to = (distM: number, v = 0) => Math.sqrt(v * v + 2 * b * Math.max(0, distM));
    let v = Math.min(this.kmph, this.maxKmph) * KMPH, hard = false;
    const cap = (x: number, obstacle: boolean) => { if (x < v) { v = x; hard = obstacle; } };
    const ahead = this.block.pathFn(head, off, head + 3);
    if (this.obeyLimits) {
      for (let km = this.tailKm; km <= head + 1e-6; km += 0.05) cap(this.route.speedLimitAt(km) * KMPH, false);
      if (!this.route.lineSpeedAt(off)) cap(30 * KMPH, false);
      for (let km = head + 0.1; km < head + 2.5; km += 0.1) {
        const lim = Math.min(this.route.speedLimitAt(km), this.route.lineSpeedAt(ahead(km)) ? Infinity : 30);
        cap(to((km - head) * 1000 - 20, lim * KMPH), false);
      }
    }
    for (const z of this.slow) {
      if (head > z.fromKm && this.tailKm < z.toKm) cap(z.kmph * KMPH, false);
      else if (z.fromKm > head) cap(to((z.fromKm - head) * 1000, z.kmph * KMPH), false);
    }
    if (this.obeySignals) {
      const sig = this.block.nextSignal(head, off, true, ahead);
      if (sig && sig.aspect === 'R' && !sig.callingOn) cap(to((sig.km - head) * 1000 - 25), true);
      else if (sig?.callingOn) cap(15 * KMPH, false);
    }
    const stop = this.nextStop();
    if (stop) cap(to((stop.km - head) * 1000 - 0.5), true);
    const end = Math.min(this.endKm ?? Infinity, this.route.lengthKm - 0.05);
    cap(to((end - head) * 1000 - 0.5), true);
    const gap = this.gapAhead(ahead);
    if (gap !== null) cap(to(gap - KEEP_CLEAR_M), true);
    return { v, hard };
  }

  /** The first stop of its path not yet made, ahead of the head. */
  private nextStop() {
    for (const s of this.stops) if (!this.served.has(s) && s.km > this.headKm - 0.01) return s;
    return null;
  }

  /** Metres to the nearest train ahead on the track it will run over (null: none within 3 km). */
  gapAhead(ahead: (km: number) => number): number | null {
    const head = this.headKm;
    let best: number | null = null;
    for (const o of this.others()) {
      if (o.id === this.id || o.headKm < head) continue;
      // the nearest part of it: its tail when ahead, or the head km itself when it overlaps (side by side or touching)
      const k = Math.max(o.tailKm, head);
      if (k > head + 3) continue;
      if (Math.abs(o.offsetAt(k) - (k > head ? ahead(k) : this.path.offsetAt(head))) > 1.5) continue;
      const d = (k - head) * 1000;
      if (best === null || d < best) best = d;
    }
    return best;
  }

  update(dt: number) {
    if (this.gone) return;
    if (this.delay > 0 && !this.held) this.delay = Math.max(0, this.delay - dt);
    if (this.dwell > 0) this.dwell = Math.max(0, this.dwell - dt);
    const { v, hard } = this.target();
    const s = STYLES[this.style];
    const rate = v < this.speed ? (hard && this.speed - v > 3 ? EMERGENCY : s.dec) : s.acc;
    this.speed = approach(this.speed, v, rate, dt);
    if (this.speed < 0.05 && v < 0.05) this.speed = 0;
    this.headKm += (this.speed * dt) / 1000;
    this.path.update(this.headKm, this.tailKm);
    // arrivals: a stop (dwell starts), the end of the path
    const stop = this.nextStop();
    if (stop && Math.abs(stop.km - this.headKm) < 0.004 && this.speed < 0.3) { this.served.add(stop); this.dwell = Math.max(0.01, stop.seconds); this.speed = 0; }
    const end = Math.min(this.endKm ?? Infinity, this.route.lengthKm - 0.05);
    if (!this.ended && this.headKm > end - 0.004 && this.speed < 0.3) { this.ended = true; this.speed = 0; }
  }
}
