import { KMPH } from '../util';
import type { Signal } from '../signalling/Signal';
import { BC_MAX, BRAKE_POSITIONS } from '../physics/BrakeSystem';
import type { TrainDynamics } from '../physics/TrainDynamics';
import type { LocoSystems } from '../train/LocoSystems';

const FULL_SERVICE = BRAKE_POSITIONS.indexOf('Full Service');
const RUNNING = BRAKE_POSITIONS.indexOf('Running');
const EMERGENCY = BRAKE_POSITIONS.indexOf('Emergency');
const DECEL = 0.45;      // planning deceleration (m/s^2), well inside full-service capability
const STOP_SHORT = 40;   // stop this far before a red signal (m)

export interface DriveTargets {
  limitKmph: number;           // speed to drive at (the limit, or whatever God Mode allows)
  /** planning deceleration (m/s^2): the normal cautious value, or the train's real braking with God Mode's instant brakes */
  decel?: number;
  nextStop: Signal | null;     // next stop signal on the set route
  stationStopKm: number | null; // booked stop marker ahead, if any
  /** stand still (a station stop in progress: doors open, boarding, waiting to depart) */
  hold?: boolean;
  /** the end of the line (buffer stops): never run past it, signals or not */
  endKm?: number;
}

/**
 * God Mode driving aids, using the real controls (so gauges, sounds and
 * physics all react normally):
 *  - autoStop: brake automatically when the braking curve to a red signal is reached
 *  - autoDrive: prepare the loco and hold a target speed from limits, signals and stops
 */
export class AutoDriver {
  private notchTimer = 0;
  braking = false;
  /** deceleration actually achieved with the brakes fully on (m/s^2), learnt while braking; 0 = not yet known */
  private measured = 0;
  private lastV = -1;
  private fullFor = 0;
  /** braking needed to make the nearest stopping point (m/s^2): above what the train can do, emergency */
  private need = 0;

  /** Highest safe speed now (m/s) given a stopping point `dist` metres ahead. */
  private decel = DECEL;
  private curve(dist: number) { return Math.sqrt(2 * this.decel * Math.max(0, dist)); }

  private targetSpeed(dyn: TrainDynamics, t: DriveTargets) {
    // plan with the asked-for deceleration, but never more than the train has shown it can do
    // (very high speeds, heavy trains, a falling grade)
    this.decel = Math.min(t.decel ?? DECEL, this.measured ? this.measured * 0.85 : Infinity);
    let v = Math.max(0, t.limitKmph - 3) * KMPH;
    this.need = 0;
    const stopAt = (dist: number) => {
      v = Math.min(v, this.curve(dist));
      if (dist > 0.5) this.need = Math.max(this.need, (dyn.speed * dyn.speed) / (2 * dist));
      else if (dyn.speed > 0.5) this.need = Infinity;
    };
    if (t.nextStop && t.nextStop.aspect === 'R' && !t.nextStop.callingOn) stopAt((t.nextStop.km - dyn.headKm) * 1000 - STOP_SHORT);
    if (t.nextStop?.callingOn) v = Math.min(v, 12 * KMPH);
    if (t.stationStopKm !== null) stopAt((t.stationStopKm - dyn.headKm) * 1000 - 2);
    if (t.endKm !== undefined) stopAt((t.endKm - dyn.headKm) * 1000);
    if (t.hold) v = 0;
    return v;
  }

  /** Learn the real braking: deceleration over half a second or more with the brakes fully applied. */
  private learn(dt: number, dyn: TrainDynamics) {
    const v = dyn.speed;
    const full = dyn.brakes.handle >= FULL_SERVICE && dyn.brakes.lastBC > BC_MAX * 0.9 && v > 1;
    this.fullFor = full ? this.fullFor + dt : 0;
    if (this.fullFor > 0.5 && dt > 0 && this.lastV > v) {
      const a = (this.lastV - v) / dt;
      this.measured = this.measured ? this.measured * 0.92 + a * 0.08 : a;
    }
    this.lastV = v;
  }

  /** Auto-stop only: intervene with a full service application if the train cannot otherwise stop at a red. */
  autoStop(dyn: TrainDynamics, sys: LocoSystems, t: DriveTargets) {
    const red = t.nextStop && t.nextStop.aspect === 'R' && !t.nextStop.callingOn;
    const need = red && dyn.speed > this.curve((t.nextStop!.km - dyn.headKm) * 1000 - STOP_SHORT) + 0.5;
    if (need) {
      if (!this.braking) this.braking = true;
      sys.setThrottle(0);
      if (dyn.brakes.handle < FULL_SERVICE) sys.setTrainBrake(FULL_SERVICE);
    } else if (this.braking && (!red || dyn.speed < 0.1)) {
      this.braking = false;
    }
  }

  /** Full auto-drive: follows limits and signals, stops at booked stations. */
  drive(dt: number, dyn: TrainDynamics, sys: LocoSystems, t: DriveTargets) {
    // prepare the loco first, like a driver would
    if (sys.isDiesel) {
      if (!sys.fuelPump) sys.toggleFuelPump();
      if (sys.engine === 'stopped' && sys.notch === 0) sys.toggleEngine();
    } else {
      if (!sys.pantoUp) sys.togglePanto();
      if (sys.pantoPos > 0.99 && !sys.vcb && sys.notch === 0) sys.toggleVcb();
    }
    if (sys.reverser !== 1 && sys.notch === 0) sys.setReverser(1);
    if (dyn.brakes.independent > 0) sys.locoBrake(-1);
    if (!sys.powerAvailable) return;

    this.learn(dt, dyn);
    const v = dyn.speed;
    const target = this.targetSpeed(dyn, t);
    this.notchTimer -= dt;
    const over = v - target;
    // a stopping point the train can no longer make with full service: emergency brake
    const capable = this.measured || this.decel / 0.85;
    if (this.need > capable * 1.1 && v > 1) {
      sys.setThrottle(0);
      if (dyn.brakes.handle !== EMERGENCY) sys.setTrainBrake(EMERGENCY);
      return;
    }
    if (target < 0.3 && v < 0.3) {
      // standing: hold with the train brake
      sys.setThrottle(0);
      if (dyn.brakes.handle < 4) sys.setTrainBrake(4);
      return;
    }
    if (over > 0.4) {
      sys.setThrottle(0);
      const want = over > 4 || this.need > this.decel * 0.9 ? FULL_SERVICE : over > 2 ? 6 : over > 1 ? 5 : 4;
      if (dyn.brakes.handle !== want) sys.setTrainBrake(want);
    } else {
      if (dyn.brakes.handle !== RUNNING && dyn.brakes.handle !== 0) sys.setTrainBrake(RUNNING);
      if (this.notchTimer <= 0 && dyn.brakes.lastBC < 0.3) {
        this.notchTimer = 0.6;
        // far below the target: full power at once; near it, a notch at a time
        if (v < target - 8) sys.setThrottle(sys.loco.notches);
        else if (v < target - 1.5) sys.throttle(1);
        else if (v > target - 0.3 && sys.notch > 0) sys.throttle(-1);
      }
    }
  }
}
