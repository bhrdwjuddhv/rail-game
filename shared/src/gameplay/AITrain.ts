import { approach, KMPH } from '../util';
import type { BlockSystem } from '../signalling/BlockSystem';
import type { Route } from '../track/Route';
import { TrackPath } from '../track/TrackGraph';
import type { StopPlan, WorkedTrain } from './Timetable';

export interface AITrainDef {
  /**
   * startKm / despawnKm are in the km of the route view the train runs in
   * (scenario files give surveyed km; the game converts for Up trains).
   * `line`: station line it starts on (or the running line); `track`: running line
   * (UP / DOWN) on a double line, default the player's.
   */
  id: string; name: string; startKm: number; line: string; maxKmph: number; wagons: number;
  stops: { station: string; line: string; dwellS: number }[];
  despawnKm: number;
  track?: string;
  /** vehicle length over couplers (default: a goods wagon) */
  carLengthM?: number;
  kind?: 'goods' | 'passenger';
  /** wagon type (data/coaches id) of the rake: container stock gets a mix of loads */
  stock?: string;
  /** locomotive (data/locomotives id) when not the default for its kind (a trainset: lengthM is its length) */
  loco?: string;
  /** starting acceleration (m/s², default 0.25) */
  accel?: number;
  /** whole train length (m) instead of loco + wagons */
  lengthM?: number;
  /** a terminating train: it stops with its head here (a bay's end) and leaves service endDwellS later */
  endAtKm?: number; endDwellS?: number;
}

export const AI_LOCO_LEN = 20.56;
export const AI_WAGON_LEN = 10.7;

/**
 * Kinematic AI train: obeys signal aspects and speed limits with a simple
 * braking curve, and stops where its plan says. Good enough to drive the
 * block system and give the player caution aspects.
 */
export class AITrain implements WorkedTrain {
  readonly id: string;
  headKm: number;
  speed = 0;
  readonly length: number;
  path: TrackPath;
  /** stood where it is for this long (s): making way for the player's train (Skip wait) */
  holdS = 0;
  readonly plan = new Map<string, StopPlan>();
  gone = false;
  /** precedence: expresses before goods (Dispatcher.overtaker) */
  readonly priority: number;
  readonly cruiseKmph: number;
  get name() { return this.def.name; }
  private dwellStops = new Set<string>();
  private endWait = 0;

  constructor(readonly def: AITrainDef, private route: Route, private block: BlockSystem) {
    this.id = def.id;
    this.length = def.lengthM ?? AI_LOCO_LEN + def.wagons * (def.carLengthM ?? AI_WAGON_LEN);
    this.priority = def.kind === 'passenger' ? 3 : 1;
    this.cruiseKmph = def.maxKmph;
    this.headKm = def.startKm;
    const st = route.stations.find(s => s.lineInfo.some(l => l.id === def.line) && def.startKm > s.entryKm && def.startKm < s.exitKm);
    const off = st?.lineInfo.find(l => l.id === def.line)?.offset ?? route.running.offset;
    this.path = new TrackPath(route.graph, this.headKm, this.tailKm, off);
    for (const s of def.stops) this.plan.set(s.station, { station: s.station, line: s.line, stop: true, dwellS: s.dwellS });
    // already moving, unless it starts standing at one of its stops
    this.speed = st && this.plan.has(st.code) ? 0 : def.maxKmph * KMPH * 0.6;
  }

  get tailKm() { return this.headKm - this.length / 1000; }
  get leavesKm() { return this.def.despawnKm; }
  offsetAt(km: number) { return this.path.offsetAt(km); }

  /** Moved across onto the line at `offset` where it stands (Skip signal: onto the middle line, out of the player's way). */
  moveToLine(offset: number) { this.path = new TrackPath(this.route.graph, this.headKm, this.tailKm, offset); }

  update(dt: number) {
    if (this.gone) return;
    if (this.holdS > 0) { this.holdS -= dt; this.speed = 0; return; }
    const head = this.headKm;
    const off = this.path.offsetAt(head);
    let limit = this.def.maxKmph;
    for (let km = this.tailKm; km <= head + 0.4; km += 0.1) limit = Math.min(limit, this.route.speedLimitAt(km));
    if (!this.route.lineSpeedAt(off)) limit = Math.min(limit, 30); // loops, turnouts, wrong line (the middle line is full speed)
    let target = limit * KMPH;
    const b = 0.35;
    // stop for red signals
    const pathFn = this.block.pathFn(head, off, head + 4);
    const next = this.block.nextSignal(head, off, true, pathFn);
    if (next && next.aspect === 'R' && !next.callingOn) {
      const d = (next.km - head) * 1000 - 25;
      target = Math.min(target, Math.sqrt(2 * b * Math.max(0, d)));
    }
    if (next && next.callingOn) target = Math.min(target, 15 * KMPH);
    // station stops
    for (const s of this.route.stations) {
      const p = this.plan.get(s.code);
      if (!p || this.dwellStops.has(s.code) || head > s.platformToKm) continue;
      const stopKm = this.route.stopKm(s, this.length);
      const d = (stopKm - head) * 1000;
      if (d < 2500) target = Math.min(target, Math.sqrt(2 * b * Math.max(0, d - 2)));
      if (d < 3 && this.speed < 0.3) this.dwellStops.add(s.code);
    }
    // a terminating train: to its stop (a bay's end), then out of service after its dwell
    if (this.def.endAtKm !== undefined) {
      const d = (this.def.endAtKm - head) * 1000;
      target = Math.min(target, Math.sqrt(2 * b * Math.max(0, d - 1)));
      if (d < 4 && this.speed < 0.3) { this.endWait += dt; if (this.endWait > (this.def.endDwellS ?? 60)) this.gone = true; }
    }
    this.speed = approach(this.speed, target, target > this.speed ? (this.def.accel ?? 0.25) : 0.7, dt);
    if (this.speed < 0.05 && target < 0.05) this.speed = 0;
    this.headKm += (this.speed * dt) / 1000;
    this.path.update(this.headKm, this.tailKm);
    if (this.headKm > this.def.despawnKm) this.gone = true;
  }
}
