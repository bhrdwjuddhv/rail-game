import * as THREE from 'three/webgpu';
import { clamp } from '../../core/util';
import type { CameraContext, CameraMode, Pose } from '../CameraManager';

/** 7: Fly anywhere. WASD move, R/F up/down, Shift fast, drag to look. */
export class FreeCamera implements CameraMode {
  readonly name = 'Free camera';
  readonly near = 0.3;
  private pos = new THREE.Vector3();
  private yaw = 0;
  private pitch = 0;
  private e = new THREE.Euler();
  private fwd = new THREE.Vector3();
  private right = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  enter(_c: CameraContext, from: Pose) {
    this.pos.copy(from.pos);
    this.e.setFromQuaternion(from.quat, 'YXZ');
    this.yaw = this.e.y; this.pitch = this.e.x;
  }
  drag(dx: number, dy: number) { this.yaw -= dx * 0.004; this.pitch = clamp(this.pitch - dy * 0.004, -1.5, 1.5); }
  update(ctx: CameraContext, out: Pose) {
    const k = ctx.keys;
    const sp = (k('ShiftLeft') || k('ShiftRight') ? 160 : 25) * ctx.dt;
    this.fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    if (k('KeyW')) this.pos.addScaledVector(this.fwd, sp);
    if (k('KeyS')) this.pos.addScaledVector(this.fwd, -sp);
    if (k('KeyD')) this.pos.addScaledVector(this.right, sp);
    if (k('KeyA')) this.pos.addScaledVector(this.right, -sp);
    if (k('KeyR')) this.pos.y += sp;
    if (k('KeyF')) this.pos.y -= sp;
    // stay within range of the train unless unlocked
    const tp = this.tmp.setFromMatrixPosition(ctx.train.vehicleMatrices[0]);
    const dx = this.pos.x - tp.x, dz = this.pos.z - tp.z, dist = Math.hypot(dx, dz);
    if (dist > ctx.freeRange) { this.pos.x = tp.x + (dx / dist) * ctx.freeRange; this.pos.z = tp.z + (dz / dist) * ctx.freeRange; }
    const g = ctx.field.height(this.pos.x, this.pos.z);
    if (this.pos.y < g + 1) this.pos.y = g + 1;
    out.pos.copy(this.pos);
    out.quat.setFromEuler(this.e.set(this.pitch, this.yaw, 0, 'YXZ'));
    out.fov = 60;
  }
}
