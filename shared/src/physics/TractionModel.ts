import { clamp, KMPH } from '../util';
import type { LocoData } from '../train/Consist';

export interface TractionInput {
  notch: number;        // 0..notches
  regenNotch: number;   // 0..regen notches
  speed: number;        // m/s, signed
  reverser: -1 | 0 | 1;
  powerAvailable: boolean; // pantograph up + breaker closed (electric) / engine running (diesel)
  adhesionN: number;    // max force the driven wheels can transmit
  dt: number;
  /** tuning (God Mode): effort/power multiplier and whether the loco's max speed cuts traction */
  powerScale?: number;
  ignoreMaxSpeed?: boolean;
}

/**
 * Shared interface so diesel-electric or other traction can plug into the same
 * train dynamics. Forces are along the track (+ = towards increasing km).
 */
export interface TractionModel {
  update(i: TractionInput): void;
  readonly tractiveForce: number;
  readonly regenForce: number; // retarding magnitude (>= 0)
  readonly slipping: boolean;
  readonly motorCurrent: number;
  readonly demandN: number;
}

/** Electric loco: constant-effort region at low speed then constant power (P/v). `units`: locos in multiple. */
export class ElectricTraction implements TractionModel {
  tractiveForce = 0;
  regenForce = 0;
  slipping = false;
  motorCurrent = 0;
  demandN = 0;
  private applied = 0; // smoothed effort, models motor current rise time

  constructor(protected loco: LocoData, protected units = 1) {}

  availableEffort(speed: number, notch: number, scale = 1, ignoreMaxSpeed = false) {
    const L = this.loco;
    const frac = notch / L.notches;
    const v = Math.max(Math.abs(speed), 0.5);
    scale *= this.units;
    const te = Math.min(L.maxTractiveEffortKN * 1000 * scale, (L.maxPowerKW * 1000 * scale) / v);
    const vmax = L.maxSpeedKmph * KMPH;
    const cutoff = ignoreMaxSpeed ? 1 : clamp((vmax * 1.05 - Math.abs(speed)) / (vmax * 0.05), 0, 1);
    return te * frac * cutoff;
  }

  regenEffort(speed: number, notch: number) {
    const r = this.loco.regen;
    const v = Math.abs(speed);
    const frac = notch / r.notches;
    const fade = clamp((v - r.fadeEndKmph * KMPH) / ((r.fadeStartKmph - r.fadeEndKmph) * KMPH), 0, 1);
    return Math.min(r.maxEffortKN * 1000, (r.maxPowerKW * 1000) / Math.max(v, 0.5)) * frac * fade * this.units;
  }

  update(i: TractionInput) {
    const motoring = i.powerAvailable && i.reverser !== 0 && i.notch > 0;
    const demand = motoring ? this.availableEffort(i.speed, i.notch, i.powerScale ?? 1, i.ignoreMaxSpeed ?? false) : 0;
    this.demandN = demand;
    // wheel slip: too much effort for available grip
    if (demand > i.adhesionN) this.slipping = true;
    else if (demand < i.adhesionN * 0.92) this.slipping = false;
    const target = this.slipping ? i.adhesionN * 0.7 : demand;
    // effort builds at ~80 kN/s, drops faster
    const rate = (target > this.applied ? 80 : 200) * 1000;
    const d = target - this.applied;
    this.applied += clamp(d, -rate * i.dt, rate * i.dt);
    this.tractiveForce = this.applied * i.reverser;

    const regen = i.powerAvailable && i.reverser !== 0 && i.regenNotch > 0 ? this.regenEffort(i.speed, i.regenNotch) : 0;
    this.regenForce = Math.min(regen, i.adhesionN);
    const totalKN = (this.applied + this.regenForce) / 1000 / this.units;
    this.motorCurrent = totalKN * this.loco.electrical.ampsPerKN; // per traction motor
  }
}

/**
 * Diesel-electric loco (same interface): the engine's power follows the notch
 * through the turbocharger lag - after notching up the power builds over a
 * few seconds (time constant diesel.turboLagS) and falls back faster when
 * notching down. Tractive effort is power / speed, capped by the starting
 * effort, like the electric. Dynamic (rheostatic) braking uses the regen
 * figures and needs the engine running. `powerAvailable` = engine running.
 */
export class DieselTraction extends ElectricTraction {
  /** power at the rail actually developed now (kW, per unit), after the turbo lag */
  powerKW = 0;

  /** engine load 0..1 (sound, smoke) */
  get load() { return this.powerKW / this.loco.maxPowerKW; }

  override availableEffort(speed: number, notch: number, scale = 1, ignoreMaxSpeed = false) {
    const L = this.loco;
    if (notch <= 0 || this.powerKW <= 0) return 0;
    const v = Math.max(Math.abs(speed), 0.5);
    scale *= this.units;
    const te = Math.min(L.maxTractiveEffortKN * 1000 * scale * (notch / L.notches), (this.powerKW * 1000 * scale) / v);
    const vmax = L.maxSpeedKmph * KMPH;
    const cutoff = ignoreMaxSpeed ? 1 : clamp((vmax * 1.05 - Math.abs(speed)) / (vmax * 0.05), 0, 1);
    return te * cutoff;
  }

  override update(i: TractionInput) {
    const L = this.loco, D = L.diesel;
    const motoring = i.powerAvailable && i.reverser !== 0 && i.notch > 0;
    const target = motoring ? L.maxPowerKW * (i.notch / L.notches) : 0;
    const lag = D?.turboLagS ?? 3;
    const tau = target > this.powerKW ? lag : lag * 0.3;
    this.powerKW += (target - this.powerKW) * (1 - Math.exp(-i.dt / tau));
    if (this.powerKW < 0.5 && target === 0) this.powerKW = 0;
    super.update(i);
  }
}

export function createTraction(loco: LocoData, units = 1): TractionModel {
  return loco.type === 'diesel' ? new DieselTraction(loco, units) : new ElectricTraction(loco, units);
}
