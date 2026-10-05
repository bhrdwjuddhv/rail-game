import * as THREE from 'three/webgpu';
import { lookAtQuat, type CameraContext, type CameraMode, type Pose } from '../CameraManager';

/** 4: Beside the loco or any coach. Press 4 again to swap sides, , and . to change vehicle. */
export class SideCamera implements CameraMode {
  readonly name = 'Side view';
  readonly near = 0.2;
  side = 1;
  vehicle = 0;
  private target = new THREE.Vector3();
  enter(_c: CameraContext, _f: Pose) {}
  again() { this.side = -this.side; }
  cycle(dir: number, n: number) { this.vehicle = (this.vehicle + dir + n) % n; }
  update(ctx: CameraContext, out: Pose) {
    const m = ctx.train.vehicleMatrices[Math.min(this.vehicle, ctx.train.vehicleMatrices.length - 1)];
    out.pos.set(-4, 2.2, this.side * 9).applyMatrix4(m);
    this.target.set(2, 2.2, 0).applyMatrix4(m);
    lookAtQuat(out.pos, this.target, out.quat);
    out.fov = 55;
  }
}
