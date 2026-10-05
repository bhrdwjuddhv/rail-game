import { clamp, KMPH } from '../../core/util';
import type { LocoData } from '../Consist';

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

/** Electric loco: constant-effort region at low speed then constant power (P/v). */
export class ElectricTraction implements TractionModel {
  tractiveForce = 0;
  regenForce = 0;
  slipping = false;
  motorCurrent = 0;
  demandN = 0;
  private applied = 0; // smoothed effort, models motor current rise time

  constructor(private loco: LocoData) {}

  availableEffort(speed: number, notch: number, scale = 1, ignoreMaxSpeed = false) {
    const L = this.loco;
    const frac = notch / L.notches;
    const v = Math.max(Math.abs(speed), 0.5);
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
    return Math.min(r.maxEffortKN * 1000, (r.maxPowerKW * 1000) / Math.max(v, 0.5)) * frac * fade;
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
    const totalKN = (this.applied + this.regenForce) / 1000;
    this.motorCurrent = totalKN * this.loco.electrical.ampsPerKN; // per traction motor
  }
}

export function createTraction(loco: LocoData): TractionModel {
  // ponytail: only electric exists; a DieselTraction class implementing TractionModel slots in here
  return new ElectricTraction(loco);
}
