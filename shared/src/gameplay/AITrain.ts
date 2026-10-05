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
  /** vehicle length incl. coupling gap (default: a goods wagon) */
  carLengthM?: number;
  kind?: 'goods' | 'passenger';
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
  readonly path: TrackPath;
  readonly plan = new Map<string, StopPlan>();
  gone = false;
  private dwellStops = new Set<string>();

  constructor(readonly def: AITrainDef, private route: Route, private block: BlockSystem) {
    this.id = def.id;
    this.length = AI_LOCO_LEN + def.wagons * (def.carLengthM ?? AI_WAGON_LEN + 0.6);
    this.headKm = def.startKm;
    const st = route.stations.find(s => s.lineInfo.some(l => l.id === def.line) && def.startKm > s.entryKm && def.startKm < s.exitKm);
    const off = st?.lineInfo.find(l => l.id === def.line)?.offset ?? route.running.offset;
    this.path = new TrackPath(route.graph, this.headKm, this.tailKm, off);
    for (const s of def.stops) this.plan.set(s.station, { station: s.station, line: s.line, stop: true, dwellS: s.dwellS });
    this.speed = def.maxKmph * KMPH * 0.6;
  }

  get tailKm() { return this.headKm - this.length / 1000; }
  offsetAt(km: number) { return this.path.offsetAt(km); }

  update(dt: number) {
    if (this.gone) return;
    const head = this.headKm;
    const off = this.path.offsetAt(head);
    let limit = this.def.maxKmph;
    for (let km = this.tailKm; km <= head + 0.4; km += 0.1) limit = Math.min(limit, this.route.speedLimitAt(km));
    if (Math.abs(off - this.route.running.offset) > 0.3) limit = Math.min(limit, 30); // loops, turnouts, wrong line
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
    this.speed = approach(this.speed, target, target > this.speed ? 0.25 : 0.7, dt);
    if (this.speed < 0.05 && target < 0.05) this.speed = 0;
    this.headKm += (this.speed * dt) / 1000;
    this.path.update(this.headKm, this.tailKm);
    if (this.headKm > this.def.despawnKm) this.gone = true;
  }
}
