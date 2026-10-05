import { approach, clamp } from '../../core/util';
import type { Vehicle } from '../Consist';

/**
 * Graduated-release automatic air brake (kg/cm^2, as on Indian stock).
 * Driver's brake valve sets the equalising reservoir; the brake pipe follows it
 * at the loco and the pressure change propagates coach by coach. Each
 * distributor valve builds brake-cylinder pressure from the pipe reduction.
 */
export const BRAKE_POSITIONS = ['Release', 'Running', 'Lap', 'Service 1', 'Service 2', 'Service 3', 'Service 4', 'Service 5', 'Full Service', 'Emergency'] as const;
export const BP_NORMAL = 5.0;
export const BC_MAX = 3.8;
const SERVICE_STEP = 0.25; // BP reduction per service notch (Full = 1.5)

export class BrakeSystem {
  /** automatic brake handle index into BRAKE_POSITIONS */
  handle = 1;
  /** independent loco brake 0..1 */
  independent = 0;
  er = BP_NORMAL;
  mr = 9.0;
  compressorOn = false;
  bp: Float32Array; // per vehicle brake pipe
  bc: Float32Array; // per vehicle brake cylinder
  penalty = false;  // vigilance/emergency penalty forces emergency until reset
  /** tuning hooks (God Mode): no pneumatic delays / unlimited main reservoir air */
  instant = false;
  infiniteAir = false;

  constructor(private vehicles: Vehicle[], startReleased = true) {
    const n = vehicles.length;
    this.bp = new Float32Array(n).fill(startReleased ? BP_NORMAL : 3.5);
    this.bc = new Float32Array(n).fill(startReleased ? 0 : BC_MAX);
  }

  get emergency() { return this.handle === BRAKE_POSITIONS.length - 1 || this.penalty; }
  get locoBP() { return this.bp[0]; }
  get locoBC() { return this.bc[0]; }
  get lastBC() { return this.bc[this.bc.length - 1]; }

  step(realDt: number, compressorPower: boolean) {
    const h = this.handle;
    // "instant" brakes: run the pneumatics so fast that every change completes within one step
    const dt = this.instant ? realDt * 400 : realDt;
    // equalising reservoir target & rate from handle position
    if (this.emergency) this.er = approach(this.er, 0, 4.0, dt);
    else if (h === 0) this.er = approach(this.er, BP_NORMAL, 1.0, dt);
    else if (h === 1) this.er = approach(this.er, BP_NORMAL, 0.45, dt);
    else if (h === 2) { /* lap: hold */ }
    else {
      const target = BP_NORMAL - (h - 2) * SERVICE_STEP;
      this.er = approach(this.er, target, this.er > target ? 0.3 : 0.45, dt);
    }

    // loco brake pipe follows ER via relay valve, limited by main reservoir
    const n = this.bp.length;
    const lead = Math.min(this.er, this.mr - 0.2);
    const r0 = lead < this.bp[0] ? (this.emergency ? 6 : 1.2) : (h === 0 ? 1.4 : 0.8);
    const before0 = this.bp[0];
    this.bp[0] = approach(this.bp[0], Math.max(0, lead), r0, dt);
    let charged = Math.max(0, this.bp[0] - before0);

    // propagation along the train: fast for reductions, slower for recharging
    for (let i = 1; i < n; i++) {
      const d = this.bp[i - 1] - this.bp[i];
      const k = d < 0 ? (this.emergency ? 14 : 7) : 2.2;
      const before = this.bp[i];
      this.bp[i] += d * Math.min(1, k * dt);
      if (this.bp[i] > before) charged += (this.bp[i] - before) * 0.05;
    }

    // distributor valves
    for (let i = 0; i < n; i++) {
      const drop = BP_NORMAL - this.bp[i];
      const target = drop < 0.12 ? 0 : clamp(drop * 2.53, 0, BC_MAX);
      const rate = target > this.bc[i] ? (this.emergency ? 1.3 : 0.85) : 0.22;
      this.bc[i] = approach(this.bc[i], target, rate, dt);
    }
    // independent brake acts on the loco cylinder directly
    const ind = this.independent * 3.5;
    if (ind > this.bc[0]) this.bc[0] = approach(this.bc[0], ind, 1.2, dt);

    // main reservoir & compressor (governor 8.0 / 10.0)
    this.mr = Math.max(0, this.mr - charged * 0.6);
    if (this.mr < 8.0 && compressorPower) this.compressorOn = true;
    if (this.mr >= 10.0 || !compressorPower) this.compressorOn = false;
    if (this.compressorOn) this.mr = Math.min(10.0, this.mr + 0.12 * realDt);
    if (this.infiniteAir) { this.mr = 10.0; this.compressorOn = false; }
  }

  /** Total friction braking force available (N, magnitude). */
  force() {
    let f = 0;
    for (let i = 0; i < this.vehicles.length; i++) f += (this.bc[i] / BC_MAX) * this.vehicles[i].maxBrakeN;
    return f;
  }
}
