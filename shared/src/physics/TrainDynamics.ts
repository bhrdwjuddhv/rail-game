import { G } from '../util';
import type { Consist } from '../train/Consist';
import { BrakeSystem } from './BrakeSystem';
import { curveResistance, davisResistance, gradeForce, startingResistance } from './ResistanceModel';
import { createTraction, TractionModel } from './TractionModel';

export interface TrainControls {
  notch: number;
  regenNotch: number;
  reverser: -1 | 0 | 1;
  sander: boolean;
  powerAvailable: boolean;
}

export interface TrackEnv {
  grade(km: number): number;
  curvature(km: number): number;
  minKm: number;
  maxKm: number;
}

/**
 * 1D longitudinal dynamics of the whole train. Each vehicle sees its own
 * gradient and curvature, so a long train straddling a summit behaves right.
 */
export class TrainDynamics {
  /** throw on non-finite state instead of repairing it; the client sets this in dev builds */
  static strictNaN = false;
  speed = 0;     // m/s, + toward increasing km
  accel = 0;
  jerk = 0;
  slack = 0;      // coupler slack displacement felt in the cab (m)
  /**
   * In-train (coupler) forces, N: the largest pull (tension, >= 0) and push
   * (compression, <= 0) at any coupling this step, and where (index of the
   * vehicle behind that coupling). The train moves as one mass; the force at a
   * coupling is what the vehicles behind it need to share that acceleration
   * minus what acts on them directly - their own brakes (which apply from the
   * front back, as the brake pipe reduction travels), gradients and
   * resistance. Harsh power or braking on a long train shows up here.
   */
  couplerMaxN = 0;
  couplerMinN = 0;
  couplerAt = 0;
  private slackVel = 0;
  readonly traction: TractionModel;
  readonly brakes: BrakeSystem;
  baseAdhesion = 0.33;
  adhesionN = 0;
  hitBuffer = false;
  odometer = 0;
  /** set once a non-finite value was caught and repaired (production builds) */
  nanRecovered = 0;
  /** tuning hooks (God Mode). Defaults = real behaviour. */
  massScale = 1;
  powerScale = 1;
  ignoreMaxSpeed = false;
  noSlip = false;

  constructor(readonly consist: Consist, public headKm: number) {
    this.traction = createTraction(consist.loco, consist.locoUnits);
    this.brakes = new BrakeSystem(consist.vehicles);
  }

  get tailKm() { return this.headKm - this.consist.length / 1000; }
  get speedKmph() { return this.speed * 3.6; }
  vehicleCentreKm(i: number) {
    const v = this.consist.vehicles[i];
    return this.headKm - (v.frontOffset + v.length / 2) / 1000;
  }

  step(dt: number, c: TrainControls, env: TrackEnv) {
    const safe = { headKm: this.headKm, speed: this.speed, slack: this.slack, slackVel: this.slackVel };
    const L = this.consist.loco;
    const mu = this.baseAdhesion + (c.sander ? L.adhesion.sanderBonus : 0);
    this.adhesionN = (this.noSlip ? 10 : mu) * this.consist.locoMass * G;

    this.brakes.step(dt, c.powerAvailable);
    this.traction.update({
      notch: c.notch, regenNotch: c.regenNotch, speed: this.speed, reverser: c.reverser,
      powerAvailable: c.powerAvailable, adhesionN: this.adhesionN, dt, powerScale: this.powerScale, ignoreMaxSpeed: this.ignoreMaxSpeed,
    });

    const vehicles = this.consist.vehicles;
    let fGrade = 0, fCurve = 0;
    for (let i = 0; i < vehicles.length; i++) {
      const km = this.vehicleCentreKm(i);
      fGrade += gradeForce(vehicles[i].massKg * this.massScale, env.grade(km));
      fCurve += curveResistance(vehicles[i].massKg * this.massScale, env.curvature(km));
    }
    const mEff = this.consist.mass * this.massScale * 1.06; // rotating mass allowance
    const drive = this.traction.tractiveForce + fGrade;
    const brake = this.brakes.force() + this.traction.regenForce;
    const prevA = this.accel;
    const v = this.speed;

    if (Math.abs(v) < 0.02) {
      const hold = startingResistance(vehicles) + fCurve + brake;
      if (Math.abs(drive) <= hold) {
        this.speed = 0;
        this.accel = 0;
      } else {
        this.accel = (drive - Math.sign(drive) * hold) / mEff;
        this.speed = v + this.accel * dt;
      }
    } else {
      const resist = davisResistance(vehicles, v) + fCurve + brake;
      this.accel = (drive - Math.sign(v) * resist) / mEff;
      let nv = v + this.accel * dt;
      // friction can stop the train but never reverse it
      if (Math.sign(nv) !== Math.sign(v)) {
        const hold = startingResistance(vehicles) + fCurve + brake;
        nv = Math.abs(drive) <= hold ? 0 : nv;
      }
      this.speed = nv;
    }

    this.headKm += (this.speed * dt) / 1000;
    this.odometer += Math.abs(this.speed * dt);
    this.hitBuffer = false;
    if (this.headKm > env.maxKm) { this.headKm = env.maxKm; this.hitBuffer = Math.abs(this.speed) > 0.3; this.speed = 0; }
    if (this.tailKm < env.minKm) { this.headKm = env.minKm + this.consist.length / 1000; this.hitBuffer = Math.abs(this.speed) > 0.3; this.speed = 0; }

    this.jerk = (this.accel - prevA) / dt;
    this.couplerForces(env);
    // coupler slack as a damped spring driven by acceleration
    const k = 18, d = 5.5;
    this.slackVel += (-k * (this.slack + this.accel * 0.12) - d * this.slackVel) * dt;
    this.slack += this.slackVel * dt;
    this.guard(safe, c);
  }

  private couplerForces(env: TrackEnv) {
    const vs = this.consist.vehicles, v = this.speed, b = this.brakes;
    let mRear = 0, fRear = 0, maxT = 0, minT = 0, at = 0;
    const dir = Math.sign(v) || Math.sign(this.accel) || 1;
    // from the rear forward: tension at the coupling ahead of vehicle i
    for (let i = vs.length - 1; i >= 1; i--) {
      const veh = vs[i], m = veh.massKg * this.massScale;
      const km = this.vehicleCentreKm(i);
      const resist = veh.davis.a + veh.davis.b * Math.abs(v) + veh.davis.c * v * v + curveResistance(m, env.curvature(km));
      let f = gradeForce(m, env.grade(km)) - dir * (b.vehicleForce(i) + (Math.abs(v) > 0.02 ? resist : 0));
      if (veh.kind === 'loco') f += (this.traction.tractiveForce - dir * this.traction.regenForce) / this.consist.locoVehicles;
      mRear += m * 1.06;
      fRear += f;
      const t = mRear * this.accel - fRear;
      if (t > maxT) { maxT = t; if (t >= -minT) at = i; }
      if (t < minT) { minT = t; if (-t > maxT) at = i; }
    }
    this.couplerMaxN = maxT;
    this.couplerMinN = minT;
    this.couplerAt = at;
  }

  /**
   * NaN/Infinity guard. In development it throws with the offending state so the
   * bug is found at its source; in production it restores the last good state,
   * logs once and keeps the run alive.
   */
  private guard(safe: { headKm: number; speed: number; slack: number; slackVel: number }, c: TrainControls) {
    if (Number.isFinite(this.headKm) && Number.isFinite(this.speed) && Number.isFinite(this.accel) && Number.isFinite(this.slack)) return;
    const detail = `headKm=${this.headKm} speed=${this.speed} accel=${this.accel} mass=${this.consist.mass} length=${this.consist.length} notch=${c.notch}`;
    if (TrainDynamics.strictNaN) throw new Error(`TrainDynamics produced a non-finite value: ${detail}`);
    if (!this.nanRecovered++) console.error(`[physics] non-finite state repaired: ${detail}`);
    this.headKm = Number.isFinite(safe.headKm) ? safe.headKm : 1;
    this.speed = Number.isFinite(safe.speed) ? safe.speed : 0;
    this.accel = 0; this.jerk = 0;
    this.slack = Number.isFinite(safe.slack) ? safe.slack : 0;
    this.slackVel = Number.isFinite(safe.slackVel) ? safe.slackVel : 0;
  }
}
