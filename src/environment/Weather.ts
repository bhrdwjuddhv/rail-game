import * as THREE from 'three/webgpu';
import { bus } from '../core/EventBus';
import { lerp, rng } from '../core/util';

export type WeatherId = 'clear' | 'hazy' | 'fog' | 'rain' | 'storm';

export interface WeatherParams {
  fog: number;        // FogExp2 density
  haze: THREE.Color;  // fog tint by day
  cloud: number;      // cloud layer opacity
  overcast: number;   // dims sun, greys the sky
  rain: number;       // 0..1
  wind: number;
  lightning: number;  // flashes per second
  adhesion: 'dry' | 'damp' | 'wet';
}

export const WEATHER: Record<WeatherId, { name: string } & Omit<WeatherParams, 'haze'> & { haze: string }> = {
  clear: { name: 'Clear', fog: 0.00022, haze: '#b9cadb', cloud: 0.18, overcast: 0, rain: 0, wind: 0.35, lightning: 0, adhesion: 'dry' },
  hazy:  { name: 'Hazy summer', fog: 0.00075, haze: '#cdbd9c', cloud: 0.2, overcast: 0.12, rain: 0, wind: 0.5, lightning: 0, adhesion: 'dry' },
  fog:   { name: 'Winter fog', fog: 0.016, haze: '#c3c7cb', cloud: 0.9, overcast: 0.75, rain: 0, wind: 0.05, lightning: 0, adhesion: 'damp' },
  rain:  { name: 'Monsoon rain', fog: 0.0026, haze: '#8f989f', cloud: 1, overcast: 0.72, rain: 0.7, wind: 1.1, lightning: 0, adhesion: 'wet' },
  storm: { name: 'Thunderstorm', fog: 0.0038, haze: '#6f777e', cloud: 1, overcast: 0.9, rain: 1, wind: 1.9, lightning: 0.07, adhesion: 'wet' },
};

const RAIN_N = 5000;

/**
 * Weather state with smooth transitions, rain streaks around the camera and
 * lightning flashes. Visibility, adhesion, windshield rain and sound all read
 * from here.
 */
export class Weather {
  id: WeatherId;
  readonly p: WeatherParams;
  private target: WeatherParams;
  readonly rainMesh: THREE.LineSegments;
  private rainPos: Float32Array;
  private seeds: Float32Array;
  flash = 0;
  private nextFlash = 5;
  private r = rng(3);

  constructor(id: WeatherId) {
    this.id = id;
    this.p = toParams(id);
    this.target = toParams(id);
    this.rainPos = new Float32Array(RAIN_N * 6);
    this.seeds = new Float32Array(RAIN_N * 3);
    for (let i = 0; i < RAIN_N; i++) { this.seeds[i * 3] = this.r() * 60 - 30; this.seeds[i * 3 + 1] = this.r() * 30; this.seeds[i * 3 + 2] = this.r() * 60 - 30; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3));
    this.rainMesh = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xc9d4dc, transparent: true, opacity: 0.32, depthWrite: false }));
    this.rainMesh.frustumCulled = false;
  }

  set(id: WeatherId, instant = false) {
    this.id = id;
    this.target = toParams(id);
    if (instant) Object.assign(this.p, this.target, { haze: this.target.haze.clone() });
  }

  /** Adhesion coefficient for the given loco data. */
  adhesion(a: { dry: number; wet: number; damp: number }) { return a[this.p.adhesion]; }

  update(dt: number, cam: THREE.Vector3, speedVec: THREE.Vector3, clearRadius: number) {
    const k = Math.min(1, dt / 8);
    const P = this.p, T = this.target;
    P.fog = lerp(P.fog, T.fog, k); P.cloud = lerp(P.cloud, T.cloud, k); P.overcast = lerp(P.overcast, T.overcast, k);
    P.rain = lerp(P.rain, T.rain, k); P.wind = lerp(P.wind, T.wind, k); P.lightning = T.lightning; P.adhesion = T.adhesion;
    P.haze.lerp(T.haze, k);

    // lightning: random double flashes
    this.flash = Math.max(0, this.flash - dt * 4);
    if (P.lightning > 0) {
      this.nextFlash -= dt;
      if (this.nextFlash <= 0) {
        this.flash = 1;
        this.nextFlash = -Math.log(1 - this.r()) / P.lightning;
        if (this.r() < 0.5) setTimeout(() => { this.flash = 0.8; }, 140);
        bus.emit('lightning', { intensity: 0.5 + this.r() * 0.5 });
      }
    }

    // rain streaks: wrap a 60x30x60 m box around the camera; tilt with wind and train speed
    this.rainMesh.visible = P.rain > 0.02;
    if (!this.rainMesh.visible) return;
    const n = Math.floor(RAIN_N * Math.min(1, P.rain));
    const fall = 10 * dt;
    const tx = -speedVec.x * 0.03 + P.wind * 0.6, tz = -speedVec.z * 0.03;
    for (let i = 0; i < RAIN_N; i++) {
      const s = i * 3;
      this.seeds[s + 1] -= fall;
      this.seeds[s] += (P.wind * 2 - speedVec.x) * dt;
      this.seeds[s + 2] -= speedVec.z * dt;
      if (this.seeds[s + 1] < -5) this.seeds[s + 1] += 30;
      for (const c of [0, 2]) { if (this.seeds[s + c] < -30) this.seeds[s + c] += 60; if (this.seeds[s + c] > 30) this.seeds[s + c] -= 60; }
      const o = i * 6;
      let x = this.seeds[s], y = this.seeds[s + 1], z = this.seeds[s + 2];
      if (i >= n || (clearRadius > 0 && x * x + z * z < clearRadius * clearRadius && y < 4)) { y = -1000; }
      this.rainPos[o] = cam.x + x; this.rainPos[o + 1] = cam.y + y - 5; this.rainPos[o + 2] = cam.z + z;
      this.rainPos[o + 3] = cam.x + x + tx; this.rainPos[o + 4] = cam.y + y - 5 - 0.7; this.rainPos[o + 5] = cam.z + z + tz;
    }
    (this.rainMesh.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }
}

function toParams(id: WeatherId): WeatherParams {
  const w = WEATHER[id];
  return { fog: w.fog, haze: new THREE.Color(w.haze), cloud: w.cloud, overcast: w.overcast, rain: w.rain, wind: w.wind, lightning: w.lightning, adhesion: w.adhesion };
}
