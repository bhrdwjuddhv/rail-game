import * as THREE from 'three/webgpu';
import { clamp } from '../../core/util';
import type { CameraContext, CameraMode, Pose } from '../CameraManager';

/** 1: Driver's seat. Mouse-drag look, wheel zoom, head bob / sway / jolts from the ride. */
export class CabCamera implements CameraMode {
  readonly name = "Driver's cab";
  readonly near = 0.1;
  readonly inCab = true;
  yaw = 0;
  pitch = -0.12;
  fov = 62;
  private sway = 0;
  private swayVel = 0;
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
    // lateral sway: spring driven by centripetal acceleration
    this.swayVel += (-30 * (this.sway - ctx.lateralAccel * 0.025) - 6 * this.swayVel) * ctx.dt;
    this.sway += this.swayVel * ctx.dt;
    const t = ctx.time;
    const ride = Math.min(1, v / 10);
    const bob = Math.sin(t * (2 + v * 0.15)) * 0.004 * Math.min(1, v / 15) + (Math.sin(t * 23.1) * 0.0012 + Math.sin(t * 37.3) * 0.0008) * ride;
    this.v.set(ctx.eye.x - ctx.slack * 0.6, ctx.eye.y + bob, ctx.eye.z + this.sway);
    const m = ctx.train.vehicleMatrices[0];
    out.pos.copy(this.v).applyMatrix4(m);
    m.decompose(this.tp, this.bodyQ, this.ts);
    // camera looks down -Z; loco forward is +X
    this.e.set(this.pitch + ctx.jolt * 0.02, this.yaw - Math.PI / 2, this.sway * 0.4 + ctx.lateralAccel * 0.004, 'YXZ');
    this.q.setFromEuler(this.e);
    out.quat.copy(this.bodyQ).multiply(this.q);
    out.fov = this.fov;
  }
}
