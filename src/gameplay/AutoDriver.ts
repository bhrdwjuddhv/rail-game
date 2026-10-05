import { KMPH } from '../core/util';
import type { Signal } from '../signalling/Signal';
import { BRAKE_POSITIONS } from '../train/physics/BrakeSystem';
import type { TrainDynamics } from '../train/physics/TrainDynamics';
import type { LocoSystems } from '../train/LocoSystems';

const FULL_SERVICE = BRAKE_POSITIONS.indexOf('Full Service');
const RUNNING = BRAKE_POSITIONS.indexOf('Running');
const DECEL = 0.45;      // planning deceleration (m/s^2), well inside full-service capability
const STOP_SHORT = 40;   // stop this far before a red signal (m)

export interface DriveTargets {
  limitKmph: number;           // current applicable limit
  nextStop: Signal | null;     // next stop signal on the set route
  stationStopKm: number | null; // booked stop marker ahead, if any
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

  /** Highest safe speed now (m/s) given a stopping point `dist` metres ahead. */
  private curve(dist: number) { return Math.sqrt(2 * DECEL * Math.max(0, dist)); }

  private targetSpeed(dyn: TrainDynamics, t: DriveTargets) {
    let v = Math.max(0, t.limitKmph - 3) * KMPH;
    if (t.nextStop && t.nextStop.aspect === 'R' && !t.nextStop.callingOn) v = Math.min(v, this.curve((t.nextStop.km - dyn.headKm) * 1000 - STOP_SHORT));
    if (t.nextStop?.callingOn) v = Math.min(v, 12 * KMPH);
    if (t.stationStopKm !== null) v = Math.min(v, this.curve((t.stationStopKm - dyn.headKm) * 1000 - 2));
    return v;
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
    if (!sys.pantoUp) sys.togglePanto();
    if (sys.pantoPos > 0.99 && !sys.vcb && sys.notch === 0) sys.toggleVcb();
    if (sys.reverser !== 1 && sys.notch === 0) sys.setReverser(1);
    if (dyn.brakes.independent > 0) sys.locoBrake(-1);
    if (!sys.vcb) return;

    const v = dyn.speed;
    const target = this.targetSpeed(dyn, t);
    this.notchTimer -= dt;
    const over = v - target;
    if (target < 0.3 && v < 0.3) {
      // standing: hold with the train brake
      sys.setThrottle(0);
      if (dyn.brakes.handle < 4) sys.setTrainBrake(4);
      return;
    }
    if (over > 0.4) {
      sys.setThrottle(0);
      const want = over > 4 ? FULL_SERVICE : over > 2 ? 6 : over > 1 ? 5 : 4;
      if (dyn.brakes.handle !== want) sys.setTrainBrake(want);
    } else {
      if (dyn.brakes.handle !== RUNNING && dyn.brakes.handle !== 0) sys.setTrainBrake(RUNNING);
      if (this.notchTimer <= 0 && dyn.brakes.lastBC < 0.3) {
        this.notchTimer = 0.6;
        if (v < target - 1.5) sys.throttle(1);
        else if (v > target - 0.3 && sys.notch > 0) sys.throttle(-1);
      }
    }
  }
}
