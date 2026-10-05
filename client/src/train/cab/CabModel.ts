import * as THREE from 'three/webgpu';
import { GeoBatch, mat } from '../../core/GeoBatch';
import { materials } from '../../core/Materials';
import { rng } from '@rail/shared/util';

/** Cab coordinates are loco-body local: +X forward, +Y up, +Z right. Front of body at x = L/2. */
export interface CabLayout {
  front: number;      // x of the cab front (L/2)
  floor: number;
  eye: THREE.Vector3; // seated driver eye position
  deskTop: number;
}

export function cabLayout(locoLength: number): CabLayout {
  const front = locoLength / 2;
  return { front, floor: 1.62, eye: new THREE.Vector3(front - 1.72, 2.92, -0.7), deskTop: 2.2 };
}

interface Drop { x: number; y: number; r: number; vx: number; vy: number; life: number }

/**
 * Cab interior shell + windshield. The windshield carries a canvas with rain
 * drops that run with speed and are wiped away by the animated wiper arms.
 */
export class CabModel {
  readonly group = new THREE.Group();
  readonly lightMat: THREE.MeshBasicMaterial;
  readonly cabLight: THREE.PointLight;
  private rainCanvas = document.createElement('canvas');
  private rainCtx: CanvasRenderingContext2D;
  private rainTex: THREE.CanvasTexture;
  private drops: Drop[] = [];
  private wipers: THREE.Object3D[] = [];
  private wiperAngle = 0;
  private wiperDir = 1;
  private r = rng(5);
  private grime: HTMLCanvasElement;
  readonly glass: THREE.Mesh[] = [];

  constructor(readonly L: CabLayout) {
    const f = L.front, fl = L.floor;
    const b = new GeoBatch();
    const back = f - 3.0;
    const wall = '#c9cfc8', dark = '#3a4046', desk = '#5b636b';
    b.box(3.1, 0.06, 2.9, mat(f - 1.5, fl, 0), '#3d3f42');                       // floor
    b.box(3.1, 0.06, 2.9, mat(f - 1.5, 4.0, 0), '#d8dcd6');                       // ceiling
    b.box(0.06, 2.4, 2.9, mat(back, fl + 1.2, 0), wall);                          // back wall
    b.box(0.07, 1.95, 0.8, mat(back + 0.04, fl + 0.98, 0.9), '#8d969e');          // door
    // side walls with window openings (x from f-2.45 to f-1.25, y 2.45..3.45)
    for (const s of [-1, 1]) {
      const z = s * 1.46;
      b.box(3.0, 0.83, 0.06, mat(f - 1.5, fl + 0.41, z), wall);
      b.box(3.0, 0.55, 0.06, mat(f - 1.5, 3.72, z), wall);
      b.box(0.55, 1.0, 0.06, mat(back + 0.27, 2.95, z), wall);
      b.box(1.25, 1.0, 0.06, mat(f - 0.62, 2.95, z), wall);
      b.box(1.2, 0.04, 0.12, mat(f - 1.85, 2.45, s * 1.42), dark);
    }
    // front: lower nose panel, windshield frame pillars, header
    b.box(0.06, 0.95, 2.9, mat(f - 0.12, fl + 0.45, 0), wall);
    for (const z of [-1.4, 0, 1.4]) {
      b.add(new THREE.BoxGeometry(0.1, 1.28, z === 0 ? 0.14 : 0.1), mat(f - 0.25, 3.13, z, 0, 0, 0.33), dark);
    }
    b.box(0.5, 0.3, 2.9, mat(f - 0.55, 3.85, 0), wall);
    b.box(0.42, 0.06, 2.9, mat(f - 0.12, 2.56, 0), dark);
    // driver's desk (left) and assistant's desk (right)
    b.add(new THREE.BoxGeometry(0.8, 0.05, 1.35), mat(f - 0.78, L.deskTop, -0.75, 0, 0, 0.18), desk);
    b.box(0.8, L.deskTop - fl, 1.35, mat(f - 0.78, (L.deskTop + fl) / 2, -0.75), '#4a5157');
    b.add(new THREE.BoxGeometry(0.06, 0.42, 1.35), mat(f - 0.4, L.deskTop + 0.2, -0.75, 0, 0, -0.38), '#2f3439'); // instrument panel, leaning back to face the eye
    b.add(new THREE.BoxGeometry(0.75, 0.05, 1.3), mat(f - 0.7, L.deskTop - 0.05, 0.76, 0, 0, 0.12), desk);
    b.box(0.75, L.deskTop - fl - 0.05, 1.3, mat(f - 0.7, (L.deskTop + fl) / 2 - 0.03, 0.76), '#4a5157');
    // seats
    for (const z of [-0.7, 0.75]) {
      b.box(0.5, 0.1, 0.5, mat(f - 1.85, fl + 0.6, z), '#2b2d30');
      b.box(0.1, 0.65, 0.5, mat(f - 2.12, fl + 0.95, z, 0, 0, 0.12), '#2b2d30');
      b.cyl(0.05, 0.05, 0.55, 8, mat(f - 1.85, fl + 0.28, z), '#555');
    }
    // overhead panel, sun visors, fire extinguisher, cupboard
    b.box(0.6, 0.12, 1.2, mat(f - 1.1, 3.9, -0.7), '#4a5157');
    for (const z of [-0.7, 0.7]) b.box(0.4, 0.02, 0.7, mat(f - 0.52, 3.6, z, 0, 0, -0.5), '#222');
    b.cyl(0.07, 0.07, 0.5, 10, mat(back + 0.15, fl + 0.3, -1.25), '#c0392b');
    b.box(0.4, 1.5, 0.7, mat(back + 0.22, fl + 0.75, -0.95), '#7d868e');
    this.group.add(b.build(materials() as unknown as Record<string, THREE.Material>, false));

    // ceiling light
    this.lightMat = new THREE.MeshBasicMaterial({ color: 0x333333 });
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.03, 0.18), this.lightMat);
    lamp.position.set(f - 1.6, 3.96, 0);
    this.group.add(lamp);
    this.cabLight = new THREE.PointLight(0xfff2d8, 0, 5, 1.5);
    this.cabLight.position.set(f - 1.6, 3.8, 0);
    this.group.add(this.cabLight);

    // windshield with rain canvas (two panes)
    this.rainCanvas.width = 512; this.rainCanvas.height = 256;
    this.rainCtx = this.rainCanvas.getContext('2d')!;
    this.rainTex = new THREE.CanvasTexture(this.rainCanvas);
    this.rainTex.colorSpace = THREE.SRGBColorSpace;
    this.grime = document.createElement('canvas');
    this.grime.width = 512; this.grime.height = 256;
    const gg = this.grime.getContext('2d')!;
    for (let i = 0; i < 260; i++) {
      const x = this.r() * 512, y = 256 - Math.pow(this.r(), 2.2) * 256;
      gg.fillStyle = `rgba(90,80,60,${0.03 + this.r() * 0.05})`;
      gg.beginPath(); gg.arc(x, y, 3 + this.r() * 18, 0, Math.PI * 2); gg.fill();
    }
    const wmat = new THREE.MeshBasicMaterial({ map: this.rainTex, transparent: true, depthWrite: false });
    for (const s of [-1, 1]) {
      const pg = new THREE.PlaneGeometry(1.3, 1.2);
      const uv = pg.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * 0.5 + (s > 0 ? 0.5 : 0));
      const pane = new THREE.Mesh(pg, wmat);
      pane.position.set(f - 0.235, 3.12, s * 0.71);
      pane.rotation.set(0, -Math.PI / 2, 0);
      pane.rotateX(-0.33);
      this.group.add(pane);
      this.glass.push(pane);
      // wiper: pivot at the bottom of the pane
      const pivot = new THREE.Object3D();
      pivot.position.set(f - 0.06, 2.58, s * 0.71 - 0.45);
      pivot.rotation.set(0, 0, 0.33);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.95, 0.025), new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.6 }));
      arm.position.y = 0.47;
      const holder = new THREE.Object3D();
      holder.add(arm);
      pivot.add(holder);
      this.group.add(pivot);
      this.wipers.push(holder);
    }
    this.drawRain(0);
  }

  /** Advance rain/wiper simulation and repaint the windshield canvas. */
  update(dt: number, rain: number, speed: number, wipers: number) {
    // wipers sweep 0..1.6 rad
    if (wipers > 0 || this.wiperAngle > 0.01) {
      const rate = wipers === 2 ? 3.4 : wipers === 1 ? 1.8 : 2.4;
      this.wiperAngle += this.wiperDir * rate * dt;
      if (this.wiperAngle > 1.6) { this.wiperAngle = 1.6; this.wiperDir = -1; }
      if (this.wiperAngle < 0) { this.wiperAngle = 0; this.wiperDir = wipers > 0 ? 1 : 0; }
      if (this.wiperDir === 0 && wipers > 0) this.wiperDir = 1;
    }
    for (const w of this.wipers) w.rotation.x = this.wiperAngle;
    // spawn drops
    const spawn = rain * dt * 140;
    for (let i = 0; i < spawn; i++) this.drops.push({ x: this.r() * 512, y: this.r() * 256, r: 1.5 + this.r() * 3.5 * rain, vx: 0, vy: 0, life: 6 + this.r() * 10 });
    // airflow pushes drops up and out with speed; gravity pulls down at low speed
    const v = Math.abs(speed);
    for (const d of this.drops) {
      d.vy = v > 8 ? -(v - 8) * (2.5 + d.r) : 6 + d.r * 4;
      d.vx = (d.x - 256) / 256 * v * 0.8;
      d.x += d.vx * dt; d.y += d.vy * dt;
      d.life -= dt;
    }
    // wiper clears drops under its arc (each pane is half the canvas)
    if (this.wiperAngle > 0.02) {
      for (const d of this.drops) {
        const pane = d.x < 256 ? 0 : 1;
        const px = pane * 256 + 30, py = 256;
        const ang = Math.atan2(d.x - px, py - d.y);
        if (Math.abs(ang - this.wiperAngle) < 0.08 && Math.hypot(d.x - px, py - d.y) < 250) d.life = 0;
      }
    }
    this.drops = this.drops.filter(d => d.life > 0 && d.y > -10 && d.y < 270 && d.x > -10 && d.x < 522);
    if (this.drops.length > 900) this.drops.splice(0, this.drops.length - 900);
    this.drawRain(rain);
  }

  private drawRain(rain: number) {
    const g = this.rainCtx;
    g.clearRect(0, 0, 512, 256);
    g.drawImage(this.grime, 0, 0);
    g.fillStyle = `rgba(160,170,180,${0.04 + rain * 0.08})`;
    g.fillRect(0, 0, 512, 256);
    for (const d of this.drops) {
      const streak = Math.min(30, Math.abs(d.vy) * 0.08);
      g.fillStyle = 'rgba(210,225,235,0.55)';
      g.beginPath(); g.ellipse(d.x, d.y, d.r * 0.8, d.r + streak, Math.atan2(d.vx, -d.vy) || 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.7)';
      g.beginPath(); g.arc(d.x - d.r * 0.3, d.y - d.r * 0.3, d.r * 0.3, 0, Math.PI * 2); g.fill();
    }
    // clean arcs where the wipers have been
    if (this.wiperAngle > 0.05) {
      g.strokeStyle = 'rgba(255,255,255,0.06)'; g.lineWidth = 2;
      for (const px of [30, 286]) { g.beginPath(); g.arc(px, 256, 230, -Math.PI / 2 - 0.05, -Math.PI / 2 + this.wiperAngle); g.stroke(); }
    }
    this.rainTex.needsUpdate = true;
  }
}
