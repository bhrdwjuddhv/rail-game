import * as THREE from 'three/webgpu';
import type { LocoRigPart } from '@rail/shared/train/Consist';

/** The cab values a rig follows (see LocoRigPart.drive). */
export type RigValues = Record<string, number>;

const DEG = Math.PI / 180;
const _off = new THREE.Color(0);

/** a node by its glTF name (GLTFLoader may have sanitised it) */
const named = (root: THREE.Object3D, n: string) => root.getObjectByName(n) ?? root.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(n)) ?? null;

interface Part { obj: THREE.Object3D; p: LocoRigPart; rest: number }
interface Lamp { mats: THREE.MeshStandardMaterial[]; drive: string; blink: boolean; glow: THREE.Color; lit: boolean | null }
interface Screen { mesh: THREE.Mesh; kind: 'drive' | 'engine'; canvas?: HTMLCanvasElement; tex?: THREE.CanvasTexture; key: string }

/**
 * A loco model's own driving cab (data model.cab.interior 'rig'): its levers, needles and switches turned
 * live from the loco, its screens drawn on canvases, its parts clickable as the cab controls they are.
 * One per loco instance; only the player's is updated (from the cab view).
 */
export class RigCab {
  /** meshes clicked as cab controls (userData.control) */
  readonly hitTargets: THREE.Object3D[] = [];
  private parts: Part[] = [];
  private screens: Screen[] = [];
  private anchors = new Map<string, THREE.Object3D>();
  private lamps: Lamp[] = [];
  private redraw = 0;
  private t = 0;

  constructor(root: THREE.Object3D, rig: LocoRigPart[], screens: Record<string, 'drive' | 'engine'> = {}, lamps: Record<string, { drive: string; color?: string; blink?: boolean }> = {}) {
    for (const p of rig) {
      const obj = named(root, p.node);
      if (!obj) continue;
      this.parts.push({ obj, p, rest: obj.rotation[p.axis] });
      if (!p.control) continue;
      this.anchors.set(p.control, obj);
      obj.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.userData.control = p.control; this.hitTargets.push(o); } });
    }
    for (const [n, kind] of Object.entries(screens)) {
      const mesh = named(root, n) as THREE.Mesh | null;
      if (mesh?.isMesh) this.screens.push({ mesh, kind, key: '' });
    }
    // lamps: this loco's own copies of their materials (shared with every loco of the type)
    for (const [name, l] of Object.entries(lamps)) {
      const mats: THREE.MeshStandardMaterial[] = [];
      root.traverse(o => {
        const m = o as THREE.Mesh, mat = m.material as THREE.MeshStandardMaterial;
        if (!m.isMesh || mat?.name !== name || !mat.isMeshStandardMaterial) return;
        const own = mats[0] ?? mat.clone();
        if (!mats.length) mats.push(own);
        m.material = own;
      });
      if (!mats.length) continue;
      const glow = new THREE.Color(l.color ?? (mats[0].emissive.getHex() ? mats[0].emissive : mats[0].color));
      this.lamps.push({ mats, drive: l.drive, blink: !!l.blink, glow, lit: null });
    }
    // the driver's display is what the tutorial means by "display" / the speed readout (or the speed dial)
    const shown = this.screens[0]?.mesh ?? this.anchors.get('gauge:speed');
    if (shown) for (const id of ['display', 'gauge:speed', 'speedo']) if (!this.anchors.has(id)) this.anchors.set(id, shown);
  }

  anchor(id: string) { return this.anchors.get(id) ?? null; }

  update(dt: number, v: RigValues) {
    for (const { obj, p, rest } of this.parts) {
      const [[v0, d0], [v1, d1]] = p.at;
      const t = THREE.MathUtils.clamp(((v[p.drive] ?? 0) - v0) / (v1 - v0 || 1), 0, 1);
      obj.rotation[p.axis] = rest + p.sign * (d0 + (d1 - d0) * t) * DEG;
    }
    this.t += dt;
    for (const l of this.lamps) {
      const lit = (v[l.drive] ?? 0) >= 0.5 && (!l.blink || this.t % 0.8 < 0.45);
      if (lit === l.lit) continue;
      l.lit = lit;
      for (const m of l.mats) { m.emissive.copy(lit ? l.glow : _off); m.emissiveIntensity = lit ? 2.2 : 0; }
    }
    if (!this.screens.length || (this.redraw -= dt) > 0) return;
    this.redraw = 0.25;
    for (const s of this.screens) this.draw(s, v);
  }

  /** a screen: its own canvas texture (the material is shared with every loco of the type: copied first) */
  private draw(s: Screen, v: RigValues) {
    const rows = s.kind === 'drive'
      ? [['SPEED', `${Math.round(v.speed ?? 0)}`, 'km/h'], ['NOTCH', (v.notch ?? 0) > 0 ? `${v.notch}` : (v.regen ?? 0) > 0 ? `DB ${v.regen}` : 'IDLE', ''], ['REV', v.reverser > 0 ? 'FWD' : v.reverser < 0 ? 'REV' : 'N', ''], ['BP', (v.bp ?? 0).toFixed(1), 'kg/cm²'], ['BC', (v.bc ?? 0).toFixed(1), 'kg/cm²']]
      : [['ENGINE', v.engine >= 1 ? 'RUN' : v.engine > 0 ? 'CRANK' : 'STOP', ''], ['RPM', `${Math.round(v.rpm ?? 0)}`, ''], ['FUEL P', (v.fuelPressure ?? 0).toFixed(1), 'kg/cm²'], ['LOAD', `${Math.round(v.amps ?? 0)}`, 'A'], ['MR', (v.mr ?? 0).toFixed(1), 'kg/cm²']];
    const key = rows.map(r => r[1]).join('|');
    if (key === s.key) return;
    s.key = key;
    if (!s.canvas) {
      s.canvas = document.createElement('canvas');
      s.canvas.width = 256; s.canvas.height = 200;
      s.tex = new THREE.CanvasTexture(s.canvas);
      s.tex.flipY = false; // glTF UVs
      s.tex.colorSpace = THREE.SRGBColorSpace;
      const m = (s.mesh.material as THREE.MeshStandardMaterial).clone();
      m.map = m.emissiveMap = s.tex; m.emissive.set(0xffffff); m.emissiveIntensity = 1; m.color.set(0xffffff);
      s.mesh.material = m;
    }
    const g = s.canvas.getContext('2d')!, w = s.canvas.width, h = s.canvas.height;
    g.fillStyle = '#04121a'; g.fillRect(0, 0, w, h);
    g.textBaseline = 'middle';
    rows.forEach(([label, value, unit], i) => {
      const y = 22 + i * 38;
      g.fillStyle = '#7fb4c8'; g.font = 'bold 18px Arial'; g.textAlign = 'left'; g.fillText(label, 10, y);
      g.fillStyle = '#e8f6ff'; g.font = 'bold 26px Arial'; g.textAlign = 'right'; g.fillText(value, unit ? 196 : 246, y);
      if (unit) { g.fillStyle = '#7fb4c8'; g.font = '14px Arial'; g.textAlign = 'left'; g.fillText(unit, 200, y); }
    });
    s.tex!.needsUpdate = true;
  }
}
