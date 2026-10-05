import * as THREE from 'three/webgpu';
import { smoothstep } from '../core/util';

/** Game clock + sun/moon positions. Seconds since midnight; `scale` = game seconds per real second. */
export class TimeOfDay {
  readonly sunDir = new THREE.Vector3();
  readonly moonDir = new THREE.Vector3();
  /** 0 at night, 1 in full day */
  day = 1;
  /** sun elevation in radians */
  elevation = 0;

  constructor(public seconds: number, public scale = 1) { this.compute(); }

  get hours() { return (this.seconds / 3600) % 24; }
  get night() { return 1 - this.day; }

  update(dt: number) {
    this.seconds = (this.seconds + dt * this.scale) % 86400;
    this.compute();
  }

  private compute() {
    const h = this.hours;
    const a = (Math.PI * (h - 6)) / 12; // 0 at 06:00, pi at 18:00
    this.elevation = Math.asin(Math.sin(a) * 0.93);
    const az = a;
    const ce = Math.cos(this.elevation);
    this.sunDir.set(Math.cos(az) * ce, Math.sin(this.elevation), Math.sin(az) * ce * 0.85 + 0.35).normalize();
    this.moonDir.set(-this.sunDir.x, Math.abs(Math.sin(a + 0.4)) * 0.8 + 0.15, -this.sunDir.z).normalize();
    this.day = smoothstep(-0.12, 0.12, this.elevation);
  }
}
