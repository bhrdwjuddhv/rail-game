import * as THREE from 'three/webgpu';
import { clamp } from '../../core/util';
import { lookAtQuat, type CameraContext, type CameraMode, type Pose } from '../CameraManager';

/** 5: Third-person orbit behind and above the train. Drag to orbit, wheel to zoom, , . to change vehicle. */
export class ChaseCamera implements CameraMode {
  readonly name = 'Chase';
  readonly near = 0.3;
  yaw = Math.PI * 0.85;
  pitch = 0.28;
  dist = 38;
  vehicle = 0;
  private target = new THREE.Vector3();
  private bq = new THREE.Quaternion();
  private e = new THREE.Euler();
  private tp = new THREE.Vector3();
  private ts = new THREE.Vector3();
  enter(_c: CameraContext, _f: Pose) {}
  drag(dx: number, dy: number) { this.yaw -= dx * 0.005; this.pitch = clamp(this.pitch + dy * 0.004, -0.1, 1.45); }
  wheel(dy: number) { this.dist = clamp(this.dist * (1 + dy * 0.001), 8, 400); }
  cycle(dir: number, n: number) { this.vehicle = (this.vehicle + dir + n) % n; }
  update(ctx: CameraContext, out: Pose) {
    const m = ctx.train.vehicleMatrices[Math.min(this.vehicle, ctx.train.vehicleMatrices.length - 1)];
    this.target.set(0, 2.5, 0).applyMatrix4(m);
    m.decompose(this.tp, this.bq, this.ts);
    const heading = this.e.setFromQuaternion(this.bq, 'YXZ').y;
    const yaw = heading + this.yaw;
    out.pos.set(
      this.target.x + Math.cos(yaw) * Math.cos(this.pitch) * this.dist,
      this.target.y + Math.sin(this.pitch) * this.dist,
      this.target.z - Math.sin(yaw) * Math.cos(this.pitch) * this.dist,
    );
    lookAtQuat(out.pos, this.target, out.quat);
    out.fov = 55;
  }
}
