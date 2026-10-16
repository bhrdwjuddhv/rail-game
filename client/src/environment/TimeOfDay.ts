import * as THREE from 'three/webgpu';
import { smoothstep } from '@rail/shared/util';
const _up = new THREE.Vector3(0, 1, 0);

/** Game clock + sun/moon positions. Seconds since midnight; `scale` = game seconds per real second. */
export class TimeOfDay {
  readonly sunDir = new THREE.Vector3();
  readonly moonDir = new THREE.Vector3();
  /** 0 at night, 1 in full day */
  day = 1;
  /** sun elevation in radians */
  elevation = 0;

  private s: number;
  /**
   * The same clock running on past midnight (never wraps): what timers compare (dwell, signalling,
   * junction traffic). A wrapped clock made every train standing at 00:00 wait for ever.
   */
  run: number;

  constructor(seconds: number, public scale = 1) { this.s = seconds; this.run = seconds; this.compute(); }

  /** time of day (s since midnight); setting it moves the run clock forward by the same amount */
  get seconds() { return this.s; }
  set seconds(v: number) {
    this.run += (((v - this.s) % 86400) + 86400) % 86400;
    this.s = ((v % 86400) + 86400) % 86400;
  }

  get hours() { return (this.seconds / 3600) % 24; }
  get night() { return 1 - this.day; }

  /** extra turn of the sun's compass direction (radians), Record Mode's "sun angle" */
  azimuth = 0;

  update(dt: number) {
    this.run += dt * this.scale;
    this.s = (this.s + dt * this.scale) % 86400;
    this.compute();
  }

  private compute() {
    const h = this.hours;
    const a = (Math.PI * (h - 6)) / 12; // 0 at 06:00, pi at 18:00
    this.elevation = Math.asin(Math.sin(a) * 0.93);
    const az = a;
    const ce = Math.cos(this.elevation);
    this.sunDir.set(Math.cos(az) * ce, Math.sin(this.elevation), Math.sin(az) * ce * 0.85 + 0.35).normalize();
    if (this.azimuth) this.sunDir.applyAxisAngle(_up, this.azimuth); // Record Mode: sun turned round the sky
    this.moonDir.set(-this.sunDir.x, Math.abs(Math.sin(a + 0.4)) * 0.8 + 0.15, -this.sunDir.z).normalize();
    this.day = smoothstep(-0.12, 0.12, this.elevation);
  }
}
