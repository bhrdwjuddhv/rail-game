import * as THREE from 'three/webgpu';
import type { CameraContext, CameraMode, Pose } from '../CameraManager';

/** 3: From the cab side window, looking back along the train (like a driver's mirror). Press 3 again to swap sides. */
export class RearCamera implements CameraMode {
  readonly name = 'Rear view';
  readonly near = 0.2;
  private side = -1;
  private q = new THREE.Quaternion();
  private bq = new THREE.Quaternion();
  private e = new THREE.Euler();
  private tp = new THREE.Vector3();
  private ts = new THREE.Vector3();
  enter(_c: CameraContext, _f: Pose) {}
  again() { this.side = -this.side; }
  update(ctx: CameraContext, out: Pose) {
    const L = ctx.train.loco.length;
    const m = ctx.train.vehicleMatrices[0];
    out.pos.set(L / 2 - 1.6, 3.3, this.side * 2.05).applyMatrix4(m);
    m.decompose(this.tp, this.bq, this.ts);
    this.q.setFromEuler(this.e.set(-0.05, Math.PI / 2 + this.side * 0.035, 0, 'YXZ'));
    out.quat.copy(this.bq).multiply(this.q);
    out.fov = 50;
  }
}
