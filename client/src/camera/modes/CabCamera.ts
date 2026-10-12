import * as THREE from 'three/webgpu';
import { clamp } from '@rail/shared/util';
import type { CameraContext, CameraMode, Pose } from '../CameraManager';

/**
 * 1: Driver's seat. Mouse-drag look, wheel zoom, head bob and jolts from the ride.
 * The driver sits in a fixed seat: the eye rides with the cab body (its lean on
 * canted curves included) and is only nudged a little by acceleration, braking
 * and cornering, smoothed, never thrown forward, back or out to the side; the
 * extra roll from cornering is small and steady (a stabilised, gyroscopic view).
 */
export class CabCamera implements CameraMode {
  readonly name = "Driver's cab";
  readonly near = 0.1;
  readonly inCab = true;
  yaw = 0;
  pitch = -0.12;
  fov = 62;
  /** smoothed seat nudges (m) and extra roll (rad) */
  private sway = 0;
  private surge = 0;
  private roll = 0;
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private bodyQ = new THREE.Quaternion();
  private tp = new THREE.Vector3();
  private ts = new THREE.Vector3();

  enter(_ctx: CameraContext, _from: Pose) {}
  drag(dx: number, dy: number) {
    this.yaw = clamp(this.yaw - dx * 0.004, -2.6, 2.6);
    this.pitch = clamp(this.pitch - dy * 0.004, -1.1, 0.9);
  }
  wheel(dy: number) { this.fov = clamp(this.fov + dy * 0.03, 25, 80); }
  again() { this.yaw = 0; this.pitch = -0.12; this.fov = 62; }

  update(ctx: CameraContext, out: Pose) {
    const v = Math.abs(ctx.speed);
    // seat nudges: a few cm at most, eased in and out (no overshoot)
    const ease = 1 - Math.exp(-ctx.dt / 0.35);
    this.sway += (clamp(ctx.lateralAccel * 0.005, -0.015, 0.015) - this.sway) * ease;
    this.surge += (clamp(-ctx.slack * 0.6, -0.03, 0.03) - this.surge) * ease;
    this.roll += (clamp(ctx.lateralAccel * 0.003, -0.012, 0.012) - this.roll) * ease;
    const t = ctx.time;
    const ride = Math.min(1, v / 10);
    const bob = Math.sin(t * (2 + v * 0.15)) * 0.004 * Math.min(1, v / 15) + (Math.sin(t * 23.1) * 0.0012 + Math.sin(t * 37.3) * 0.0008) * ride;
    // pressure wave of a passing train: quick lateral buffet
    const k = ctx.shake;
    const buffet = k * (Math.sin(t * 29.3) * 0.012 + Math.sin(t * 47.9) * 0.007);
    this.v.set(ctx.eye.x + this.surge, ctx.eye.y + bob + k * Math.sin(t * 41.7) * 0.004, ctx.eye.z + this.sway + buffet);
    const m = ctx.train.vehicleMatrices[0];
    out.pos.copy(this.v).applyMatrix4(m);
    m.decompose(this.tp, this.bodyQ, this.ts);
    // camera looks down -Z; loco forward is +X
    this.e.set(this.pitch + ctx.jolt * 0.02, this.yaw - Math.PI / 2, this.roll + buffet * 0.6, 'YXZ');
    this.q.setFromEuler(this.e);
    out.quat.copy(this.bodyQ).multiply(this.q);
    out.fov = this.fov;
  }
}
