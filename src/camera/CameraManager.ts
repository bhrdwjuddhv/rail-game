import * as THREE from 'three/webgpu';
import { bus } from '../core/EventBus';
import type { Route } from '../track/Route';
import type { TrainView } from '../train/Coach';
import type { TerrainField } from '../world/TerrainField';

/** What every camera mode can read. Filled in by the game each frame. */
export interface CameraContext {
  dt: number;
  time: number;
  train: TrainView;
  route: Route;
  field: TerrainField;
  headKm: number;
  speed: number;          // m/s
  lateralAccel: number;   // m/s^2 (curve centripetal)
  slack: number;          // coupler slack displacement (m)
  jolt: number;           // recent jolt magnitude 0..1
  eye: THREE.Vector3;     // cab eye in loco-body local coords
  keys: (code: string) => boolean;
  /** max distance (m) the free camera may fly from the train (God Mode can unlock) */
  freeRange: number;
}

export interface Pose { pos: THREE.Vector3; quat: THREE.Quaternion; fov: number }

/** Shared interface: add a new mode by implementing this and registering it. */
export interface CameraMode {
  readonly name: string;
  readonly near: number;
  /** true if this mode is inside the cab (shows the interior, hides exterior glass) */
  readonly inCab?: boolean;
  enter(ctx: CameraContext, from: Pose): void;
  update(ctx: CameraContext, out: Pose): void;
  exit?(): void;
  drag?(dx: number, dy: number): void;
  wheel?(dy: number): void;
  /** repeated press of the mode key (e.g. switch side) */
  again?(): void;
  cycle?(dir: number, vehicles: number): void;
}

export class CameraManager {
  readonly camera: THREE.PerspectiveCamera;
  private modes: CameraMode[] = [];
  index = 0;
  private blend = 1;
  private from: Pose = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: 60 };
  private pose: Pose = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: 60 };
  private started = false;

  constructor(aspect: number, far: number) {
    this.camera = new THREE.PerspectiveCamera(60, aspect, 0.05, far);
  }

  register(m: CameraMode) { this.modes.push(m); }
  get mode() { return this.modes[this.index]; }

  select(i: number, ctx: CameraContext) {
    if (i < 0 || i >= this.modes.length) return;
    if (i === this.index && this.started) { this.mode.again?.(); return; }
    this.mode?.exit?.();
    this.from.pos.copy(this.camera.position);
    this.from.quat.copy(this.camera.quaternion);
    this.from.fov = this.camera.fov;
    this.index = i;
    this.mode.enter(ctx, this.from);
    this.blend = this.started ? 0 : 1;
    this.started = true;
    bus.emit('camera', { mode: i + 1 });
  }

  update(ctx: CameraContext) {
    if (!this.started) this.select(this.index, ctx);
    const m = this.mode;
    m.update(ctx, this.pose);
    this.blend = Math.min(1, this.blend + ctx.dt / 0.6);
    const t = this.blend * this.blend * (3 - 2 * this.blend);
    if (t < 1) {
      this.camera.position.copy(this.from.pos).lerp(this.pose.pos, t);
      this.camera.quaternion.copy(this.from.quat).slerp(this.pose.quat, t);
      this.camera.fov = this.from.fov + (this.pose.fov - this.from.fov) * t;
    } else {
      this.camera.position.copy(this.pose.pos);
      this.camera.quaternion.copy(this.pose.quat);
      this.camera.fov = this.pose.fov;
    }
    // keep out of the ground for outside cameras
    if (!m.inCab) {
      const g = ctx.field.height(this.camera.position.x, this.camera.position.z);
      if (this.camera.position.y < g + 0.6) this.camera.position.y = g + 0.6;
    }
    this.camera.near = t < 1 ? Math.min(m.near, 0.1) : m.near;
    this.camera.updateProjectionMatrix();
  }

  drag(dx: number, dy: number) { this.mode.drag?.(dx, dy); }
  wheel(dy: number) { this.mode.wheel?.(dy); }
  cycle(dir: number, vehicles: number) { this.mode.cycle?.(dir, vehicles); }
}

// helpers shared by modes
const _m = new THREE.Matrix4();
export function locoMatrix(ctx: CameraContext) { return ctx.train.vehicleMatrices[0]; }
export function localToWorld(ctx: CameraContext, local: THREE.Vector3, out: THREE.Vector3, vehicle = 0) {
  return out.copy(local).applyMatrix4(ctx.train.vehicleMatrices[vehicle]);
}
export function lookAtQuat(from: THREE.Vector3, to: THREE.Vector3, out: THREE.Quaternion) {
  _m.lookAt(from, to, new THREE.Vector3(0, 1, 0));
  return out.setFromRotationMatrix(_m);
}
