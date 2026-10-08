import * as THREE from 'three/webgpu';
import { allLabelMaterials, materials } from '../core/Materials';
import { clamp, lerp } from '@rail/shared/util';
import type { QualityPreset } from '../core/Settings';
import type { Sky } from './Sky';
import type { TimeOfDay } from './TimeOfDay';
import type { Weather } from './Weather';

/**
 * Sun/moon directional light with a shadow frustum that follows the camera
 * focus, hemisphere ambient, fog, night lamp materials, a small pool of point
 * lights for nearby station lamps, and tunnel darkening.
 */
export class Lighting {
  readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  readonly hemi = new THREE.HemisphereLight(0xbfd4ff, 0x5d5040, 0.8);
  readonly fog = new THREE.FogExp2(0xb9cadb, 0.0003);
  readonly pool: THREE.PointLight[] = [];
  private shadowSize = 0;
  nightLight = 0;   // 0..1 for emissive windows/lamps
  tunnel = 0;       // 0..1 how far inside a tunnel the camera is

  /** lights live under the floating-origin world group; fog belongs to the scene */
  constructor(scene: THREE.Scene, world: THREE.Object3D) {
    world.add(this.sun, this.sun.target, this.hemi);
    scene.fog = this.fog;
    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight(0xffe2b0, 0, 40, 1.6);
      this.pool.push(l);
      world.add(l);
    }
  }

  applyQuality(p: QualityPreset) {
    // 2048 over 220 m is about 11 cm a texel: as sharp as 4096 looked at driving distances, at a quarter of the fill
    const size = p.shadows === 'high' ? 2048 : p.shadows === 'low' ? 1024 : 0;
    this.sun.castShadow = size > 0;
    if (size && size !== this.shadowSize) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      (this.sun.shadow as any).map = null;
      const cam = this.sun.shadow.camera as THREE.OrthographicCamera;
      const half = p.shadows === 'high' ? 110 : 80;
      cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half;
      cam.near = 1; cam.far = 1200;
      cam.updateProjectionMatrix();
      this.sun.shadow.bias = -0.0004;
      this.sun.shadow.normalBias = 0.6;
    }
    this.shadowSize = size;
  }

  update(focus: THREE.Vector3, time: TimeOfDay, w: Weather, sky: Sky, fogMul: number, lampSpots: THREE.Vector3[], cam: THREE.Vector3) {
    const day = time.day;
    const oc = w.p.overcast;
    const dark = 1 - this.tunnel * 0.94;
    const moonUp = time.night > 0.5;
    const dir = moonUp ? time.moonDir : time.sunDir;
    // shadow-casting light follows the focus, snapped to texels to avoid shimmer
    const cam2 = this.sun.shadow.camera as THREE.OrthographicCamera;
    const texel = (cam2.right - cam2.left) / Math.max(1, this.sun.shadow.mapSize.x);
    const fx = Math.round(focus.x / texel) * texel, fz = Math.round(focus.z / texel) * texel;
    this.sun.target.position.set(fx, focus.y, fz);
    this.sun.position.set(fx + dir.x * 500, focus.y + Math.max(0.15, dir.y) * 500, fz + dir.z * 500);
    const sunCol = new THREE.Color().setRGB(1, lerp(0.62, 0.97, clamp(time.elevation * 4, 0, 1)), lerp(0.4, 0.92, clamp(time.elevation * 3, 0, 1)));
    if (moonUp) {
      this.sun.color.setRGB(0.6, 0.7, 1);
      this.sun.intensity = 0.22 * (1 - oc) * dark;
    } else {
      this.sun.color.copy(sunCol);
      this.sun.intensity = 3.2 * day * (1 - oc * 0.72) * dark;
    }
    const flash = w.flash;
    this.hemi.color.copy(sky.zenith).lerp(new THREE.Color(1, 1, 1), 0.35);
    // ground bounce: sunlit ballast, platforms and fields light the undersides of roofs, bridges and vehicles
    this.hemi.groundColor.setRGB(0.5, 0.44, 0.36).multiplyScalar(0.3 + day * 0.7);
    this.hemi.intensity = (0.12 + day * (0.75 + oc * 0.35) + flash * 2.5) * dark + 0.03;

    // fog follows the horizon colour; darker at night and in tunnels
    this.fog.color.copy(sky.horizon).lerp(w.p.haze.clone().multiplyScalar(0.2 + day * 0.8), 0.5).multiplyScalar(dark);
    this.fog.density = w.p.fog * fogMul * (1 + this.tunnel * 6);

    // night lamps
    this.nightLight = clamp(1 - day * 1.6 + oc * 0.25, 0, 1);
    const M = materials();
    const lampOn = this.nightLight > 0.25;
    M.lamp.color.setRGB(lampOn ? 4 : 0.75, lampOn ? 3.6 : 0.75, lampOn ? 2.8 : 0.7);
    M.facade.emissiveIntensity = this.nightLight * 0.9;
    for (const m of allLabelMaterials()) m.emissiveIntensity = 0.04 + this.nightLight * 0.12;

    // pooled point lights at the nearest platform lamps
    const near = lampOn ? [...lampSpots].sort((a, b) => a.distanceToSquared(cam) - b.distanceToSquared(cam)).slice(0, this.pool.length) : [];
    this.pool.forEach((l, i) => {
      const p = near[i];
      if (p && p.distanceTo(cam) < 600) { l.position.copy(p); l.intensity = 120 * this.nightLight; }
      else l.intensity = 0;
    });
  }
}
