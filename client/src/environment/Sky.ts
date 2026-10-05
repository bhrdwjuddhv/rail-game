import * as THREE from 'three/webgpu';
import { canvasTexture, tex } from '../core/Textures';
import { clamp, lerp, rng, smoothstep } from '@rail/shared/util';
import type { TimeOfDay } from './TimeOfDay';
import type { Weather } from './Weather';

const C = (h: string) => new THREE.Color(h);
// sky keyframes by sun elevation (degrees)
const KEYS: { el: number; zenith: THREE.Color; horizon: THREE.Color; glow: THREE.Color }[] = [
  { el: -18, zenith: C('#01030a'), horizon: C('#060b18'), glow: C('#0a0f1c') },
  { el: -8, zenith: C('#0b1430'), horizon: C('#2a2d4a'), glow: C('#6b3a3a') },
  { el: -2, zenith: C('#1c2f5c'), horizon: C('#b0603a'), glow: C('#ff7a3a') },
  { el: 4, zenith: C('#3366a8'), horizon: C('#e8a066'), glow: C('#ffb060') },
  { el: 14, zenith: C('#2c69bf'), horizon: C('#a9c6e2'), glow: C('#fff0c8') },
  { el: 60, zenith: C('#1f5fb8'), horizon: C('#a8c8e8'), glow: C('#ffffff') },
];

/**
 * Vertex-coloured sky dome (colours recomputed on the CPU each frame - no
 * custom shaders so it works on WebGPU and WebGL2 alike), sun and moon
 * sprites, stars and a scrolling cloud layer.
 */
export class Sky {
  readonly group = new THREE.Group();
  private dome: THREE.Mesh;
  private dirs: THREE.Vector3[] = [];
  private colors: Float32Array;
  private sun: THREE.Sprite;
  private moon: THREE.Sprite;
  private stars: THREE.Points;
  private clouds: THREE.Mesh;
  readonly horizon = new THREE.Color();
  readonly zenith = new THREE.Color();
  private tmp = new THREE.Color();
  private cloudOffset = 0;

  constructor(radius: number) {
    const geo = new THREE.SphereGeometry(radius, 32, 16);
    const p = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) this.dirs.push(new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i)).normalize());
    this.colors = new Float32Array(p.count * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.dome = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    this.dome.renderOrder = -10;
    this.dome.frustumCulled = false;
    this.group.add(this.dome);

    this.sun = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex.glow(), color: 0xfff4d6, fog: false, depthWrite: false, blending: THREE.AdditiveBlending, transparent: true }));
    this.sun.scale.setScalar(radius * 0.12);
    const moonTex = canvasTexture('moon', 128, 128, (g) => {
      g.clearRect(0, 0, 128, 128);
      g.fillStyle = '#e9e6dc'; g.beginPath(); g.arc(64, 64, 52, 0, Math.PI * 2); g.fill();
      const r = rng(2);
      for (let i = 0; i < 14; i++) { g.fillStyle = 'rgba(150,145,135,0.5)'; g.beginPath(); g.arc(30 + r() * 68, 30 + r() * 68, 3 + r() * 9, 0, Math.PI * 2); g.fill(); }
    }, { repeat: false });
    this.moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: moonTex, fog: false, depthWrite: false, transparent: true }));
    this.moon.scale.setScalar(radius * 0.035);
    this.group.add(this.sun, this.moon);

    const r = rng(1);
    const sp: number[] = [];
    for (let i = 0; i < 2500; i++) {
      const u = r() * 2 - 1, a = r() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      const v = new THREE.Vector3(Math.cos(a) * s, Math.abs(u), Math.sin(a) * s).multiplyScalar(radius * 0.95);
      sp.push(v.x, v.y, v.z);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
    this.stars.frustumCulled = false;
    this.group.add(this.stars);

    const ct = tex.cloud().clone();
    ct.wrapS = ct.wrapT = THREE.RepeatWrapping;
    ct.repeat.set(4, 4);
    ct.needsUpdate = true;
    this.clouds = new THREE.Mesh(new THREE.PlaneGeometry(radius * 3, radius * 3).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ map: ct, transparent: true, opacity: 0.3, fog: false, depthWrite: false, side: THREE.DoubleSide }));
    this.clouds.position.y = 900;
    this.clouds.renderOrder = -9;
    this.clouds.frustumCulled = false;
    this.group.add(this.clouds);
  }

  update(dt: number, cam: THREE.Vector3, time: TimeOfDay, w: Weather) {
    this.group.position.copy(cam);
    const el = (time.elevation * 180) / Math.PI;
    let i = 0;
    while (i < KEYS.length - 2 && el > KEYS[i + 1].el) i++;
    const a = KEYS[i], b = KEYS[i + 1];
    const t = clamp((el - a.el) / (b.el - a.el), 0, 1);
    this.zenith.copy(a.zenith).lerp(b.zenith, t);
    this.horizon.copy(a.horizon).lerp(b.horizon, t);
    const glow = a.glow.clone().lerp(b.glow, t);
    // overcast / haze greys the sky
    const grey = this.tmp.copy(w.p.haze).multiplyScalar(0.25 + time.day * 0.75);
    const oc = clamp(w.p.overcast + Math.min(1, w.p.fog * 40) * 0.6, 0, 1);
    this.zenith.lerp(grey, oc);
    this.horizon.lerp(grey, oc * 0.9 + 0.1 * Math.min(1, w.p.fog * 400));
    const flash = w.flash;
    const sd = time.sunDir;
    const col = new THREE.Color();
    for (let k = 0; k < this.dirs.length; k++) {
      const d = this.dirs[k];
      const up = Math.max(0, d.y);
      col.copy(this.horizon).lerp(this.zenith, Math.pow(up, 0.55));
      if (d.y < 0) col.copy(this.horizon).multiplyScalar(0.8);
      const s = Math.max(0, d.dot(sd));
      const g = Math.pow(s, 8) * (1 - oc) * smoothstep(-0.25, 0.1, time.elevation);
      col.r += glow.r * g * 0.6; col.g += glow.g * g * 0.6; col.b += glow.b * g * 0.6;
      col.r += flash * 0.7; col.g += flash * 0.72; col.b += flash * 0.85;
      this.colors[k * 3] = col.r; this.colors[k * 3 + 1] = col.g; this.colors[k * 3 + 2] = col.b;
    }
    (this.dome.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;

    const R = (this.dome.geometry as THREE.SphereGeometry).parameters.radius * 0.9;
    this.sun.position.copy(sd).multiplyScalar(R);
    this.sun.visible = time.elevation > -0.1;
    (this.sun.material as THREE.SpriteMaterial).opacity = (1 - oc * 0.9) * smoothstep(-0.1, 0.05, time.elevation);
    (this.sun.material as THREE.SpriteMaterial).color.copy(glow);
    this.moon.position.copy(time.moonDir).multiplyScalar(R);
    (this.moon.material as THREE.SpriteMaterial).opacity = time.night * (1 - oc);
    (this.stars.material as THREE.PointsMaterial).opacity = Math.pow(time.night, 2) * (1 - oc) * 0.9;
    this.cloudOffset += dt * 0.0015 * (0.3 + w.p.wind);
    const cm = this.clouds.material as THREE.MeshBasicMaterial;
    cm.map!.offset.set(this.cloudOffset, this.cloudOffset * 0.3);
    cm.opacity = lerp(0.15, 0.9, w.p.cloud);
    cm.color.copy(this.horizon).lerp(new THREE.Color(1, 1, 1), time.day * (1 - oc * 0.6)).multiplyScalar(0.3 + time.day * 0.8);
  }
}
