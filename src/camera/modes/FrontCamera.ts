import * as THREE from 'three/webgpu';
import type { CameraContext, CameraMode, Pose } from '../CameraManager';

/** 2: Low on the nose, looking ahead down the line. Drag to look around a little. */
export class FrontCamera implements CameraMode {
  readonly name = 'Front view';
  readonly near = 0.2;
  private yaw = 0;
  private q = new THREE.Quaternion();
  private bq = new THREE.Quaternion();
  private e = new THREE.Euler();
  private tp = new THREE.Vector3();
  private ts = new THREE.Vector3();
  enter(_c: CameraContext, _f: Pose) {}
  drag(dx: number) { this.yaw = Math.max(-1.2, Math.min(1.2, this.yaw - dx * 0.004)); }
  update(ctx: CameraContext, out: Pose) {
    const L = ctx.train.loco.length;
    const m = ctx.train.vehicleMatrices[0];
    out.pos.set(L / 2 + 0.7, 1.45, 0.9).applyMatrix4(m);
    m.decompose(this.tp, this.bq, this.ts);
    this.q.setFromEuler(this.e.set(-0.02, this.yaw - Math.PI / 2, 0, 'YXZ'));
    out.quat.copy(this.bq).multiply(this.q);
    out.fov = 58;
  }
}
