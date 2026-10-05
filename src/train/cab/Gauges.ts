import * as THREE from 'three/webgpu';
import { GeoBatch, mat } from '../../core/GeoBatch';
import { Atlas, uvToRect } from '../../core/Textures';
import { clamp } from '../../core/util';

/**
 * Analogue needle gauge. The dial face is drawn into a shared atlas and its
 * bezel/cap go into a shared static batch, so all gauges together cost one
 * draw for faces, one for bezels, plus one per needle.
 */
export class Gauge {
  private needles: THREE.Object3D[] = [];
  private shown: number[] = [];

  constructor(atlas: Atlas, faces: GeoBatch, statics: GeoBatch, parent: THREE.Object3D, x: number, y: number,
    readonly label: string, readonly min: number, readonly max: number, unit: string, radius: number,
    opts: { majors?: number; needles?: string[]; redFrom?: number } = {}) {
    const majors = opts.majors ?? 8;
    const rect = atlas.add(256, 256, (g) => {
      g.fillStyle = '#101214'; g.beginPath(); g.arc(128, 128, 126, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#f4f1e6'; g.beginPath(); g.arc(128, 128, 116, 0, Math.PI * 2); g.fill();
      const a0 = -Math.PI * 0.75, a1 = Math.PI * 0.75;
      if (opts.redFrom !== undefined) {
        g.strokeStyle = '#c0392b'; g.lineWidth = 8; g.beginPath();
        const ar = a0 + ((opts.redFrom - min) / (max - min)) * (a1 - a0);
        g.arc(128, 128, 100, ar - Math.PI / 2, a1 - Math.PI / 2); g.stroke();
      }
      g.strokeStyle = '#111'; g.fillStyle = '#111'; g.textAlign = 'center'; g.textBaseline = 'middle';
      for (let i = 0; i <= majors * 5; i++) {
        const t = i / (majors * 5), a = a0 + t * (a1 - a0) - Math.PI / 2;
        const major = i % 5 === 0;
        g.lineWidth = major ? 3 : 1.5;
        const r0 = major ? 86 : 94;
        g.beginPath(); g.moveTo(128 + Math.cos(a) * r0, 128 + Math.sin(a) * r0); g.lineTo(128 + Math.cos(a) * 106, 128 + Math.sin(a) * 106); g.stroke();
        if (major) {
          g.font = 'bold 20px Arial';
          g.fillText(String(Math.round((min + t * (max - min)) * 10) / 10), 128 + Math.cos(a) * 68, 128 + Math.sin(a) * 68);
        }
      }
      g.font = 'bold 18px Arial'; g.fillText(label, 128, 170);
      g.font = '15px Arial'; g.fillText(unit, 128, 192);
      (opts.needles ?? []).forEach((n, i) => { g.fillStyle = i ? '#c0392b' : '#111'; g.fillText(n, 128 + (i ? 30 : -30), 92); });
    });
    faces.add(uvToRect(new THREE.CircleGeometry(radius, 32), rect), mat(x, y, 0), '#ffffff', 'faces');
    statics.add(new THREE.TorusGeometry(radius, radius * 0.06, 6, 32), mat(x, y, 0), '#2c2f33', 'metal');
    statics.add(new THREE.CircleGeometry(radius * 0.08, 12), mat(x, y, 0.012), '#222222', 'std');
    const colors = [0x111111, 0xc0392b];
    for (let i = 0; i < Math.max(1, opts.needles?.length ?? 1); i++) {
      const pivot = new THREE.Object3D();
      pivot.position.set(x, y, 0);
      const n = new THREE.Mesh(new THREE.BoxGeometry(radius * 0.035, radius * 0.82, 0.004), new THREE.MeshBasicMaterial({ color: colors[i] }));
      n.position.set(0, radius * 0.38, 0.006 + i * 0.002);
      pivot.add(n);
      parent.add(pivot);
      this.needles.push(pivot);
      this.shown.push(min);
    }
  }

  /** object at the dial centre (for tutorial highlights) */
  get anchor(): THREE.Object3D { return this.needles[0]; }

  set(values: number[], dt: number) {
    values.forEach((v, i) => {
      const n = this.needles[i];
      if (!n) return;
      // needle damping
      this.shown[i] += (clamp(v, this.min, this.max) - this.shown[i]) * Math.min(1, dt * 6);
      const t = (this.shown[i] - this.min) / (this.max - this.min);
      n.rotation.z = -(-Math.PI * 0.75 + t * Math.PI * 1.5);
    });
  }
}

/** Small LCD-style driver display, redrawn a few times per second. */
export class DriverDisplay {
  readonly mesh: THREE.Mesh;
  private canvas = document.createElement('canvas');
  private tex: THREE.CanvasTexture;
  private last = '';

  constructor(w: number, h: number) {
    this.canvas.width = 512; this.canvas.height = 320;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: this.tex }));
  }

  draw(d: { speed: number; limit: number; km: number; notch: number; regen: number; reverser: number; nextSignal: string; signalDist: number; aspect: string; te: number; clock: string; units: string }) {
    // only repaint + re-upload when something visible changed
    const key = `${Math.round(d.speed)}|${d.limit}|${d.km.toFixed(3)}|${d.notch}|${d.regen}|${d.reverser}|${d.nextSignal}|${Math.round(d.signalDist / 5)}|${d.aspect}|${Math.round(d.te)}|${d.clock}|${d.units}`;
    if (key === this.last) return;
    this.last = key;
    const g = this.canvas.getContext('2d')!;
    g.fillStyle = '#04140c'; g.fillRect(0, 0, 512, 320);
    g.fillStyle = '#4dff9a'; g.font = 'bold 84px monospace'; g.textAlign = 'left';
    g.fillText(String(Math.round(d.speed)).padStart(3, ' '), 20, 96);
    g.font = '24px monospace';
    g.fillText(d.units, 200, 96);
    g.fillStyle = d.speed > d.limit + 2 ? '#ff5050' : '#ffd24d';
    g.fillText(`LIMIT ${d.limit}`, 300, 60);
    g.fillStyle = '#4dff9a';
    g.fillText(d.clock, 300, 96);
    g.font = '26px monospace';
    g.fillText(`KM ${d.km.toFixed(3)}`, 20, 150);
    g.fillText(`NOTCH ${d.notch > 0 ? 'P' + d.notch : d.regen > 0 ? 'B' + d.regen : '0'}`, 280, 150);
    g.fillText(`REV ${d.reverser > 0 ? 'FWD' : d.reverser < 0 ? 'REV' : 'NEU'}`, 20, 196);
    g.fillText(`TE ${Math.round(d.te)} kN`, 280, 196);
    const col: Record<string, string> = { R: '#ff3b30', Y: '#ffcc00', YY: '#ffcc00', G: '#34ff7a', '-': '#555' };
    g.fillStyle = col[d.aspect] ?? '#555';
    g.beginPath(); g.arc(44, 260, 22, 0, Math.PI * 2); g.fill();
    if (d.aspect === 'YY') { g.beginPath(); g.arc(96, 260, 22, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = '#4dff9a';
    g.fillText(`${d.nextSignal}  ${d.signalDist < 9999 ? Math.round(d.signalDist) + ' m' : ''}`, 130, 270);
    this.tex.needsUpdate = true;
  }
}

/** All warning lamps as one instanced mesh (one draw); labels go into the atlas. */
export class LampPanel {
  readonly mesh: THREE.InstancedMesh;
  private colors: THREE.Color[] = [];
  private off = new THREE.Color(0.07, 0.07, 0.07);
  private tmp = new THREE.Color();

  constructor(atlas: Atlas, labels: GeoBatch, defs: { label: string; color: number; x: number; y: number }[]) {
    this.mesh = new THREE.InstancedMesh(new THREE.CircleGeometry(0.018, 14), new THREE.MeshBasicMaterial({ color: 0xffffff }), defs.length);
    defs.forEach((d, i) => {
      this.mesh.setMatrixAt(i, mat(d.x, d.y, 0.002));
      this.mesh.setColorAt(i, this.off);
      this.colors.push(new THREE.Color(d.color));
      const r = atlas.add(128, 32, g => { g.fillStyle = '#16181a'; g.fillRect(0, 0, 128, 32); g.fillStyle = '#ddd'; g.font = 'bold 20px Arial'; g.textAlign = 'center'; g.fillText(d.label, 64, 23); });
      labels.add(uvToRect(new THREE.PlaneGeometry(0.07, 0.0175), r), mat(d.x, d.y - 0.033, 0.002), '#ffffff', 'faces');
    });
    this.mesh.computeBoundingSphere();
  }

  set(i: number, on: boolean) {
    this.mesh.setColorAt(i, on ? this.tmp.copy(this.colors[i]).multiplyScalar(3) : this.off);
    this.mesh.instanceColor!.needsUpdate = true;
  }
}
