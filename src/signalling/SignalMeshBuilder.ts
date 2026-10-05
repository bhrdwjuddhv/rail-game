import * as THREE from 'three/webgpu';
import { GeoBatch, mat } from '../core/GeoBatch';
import { labelTexture, tex } from '../core/Textures';
import { labelMaterial, materials } from '../core/Materials';
import { newFrame, RAIL_TOP } from '../track/Chainage';
import type { Route } from '../track/Route';
import type { Signal } from './Signal';

const LAMP_COLORS = { Y: new THREE.Color(1.0, 0.62, 0.05), G: new THREE.Color(0.15, 1.0, 0.45), R: new THREE.Color(1.0, 0.06, 0.04), W: new THREE.Color(1, 0.95, 0.85) };
type LampKey = 'Y' | 'G' | 'R' | 'Y2' | 'C' | `RI${number}`;

interface Lamp { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; glow: THREE.Sprite; color: THREE.Color }

/**
 * Indian colour-light signal: post, black backplate with white border, hooded
 * lamps (top to bottom Y, G, R, Y), "P" plate on distants, calling-on lamp and
 * a junction-type route indicator feather on homes that need it.
 */
export class SignalView {
  readonly group = new THREE.Group();
  readonly position = new THREE.Vector3();
  private lamps = new Map<LampKey, Lamp>();

  constructor(route: Route, readonly signal: Signal) {
    const d = signal.def;
    const f = newFrame();
    route.alignment.sampleOffset(d.km * 1000, d.offset - 2.6, f);
    this.group.position.set(f.x, f.y + RAIL_TOP, f.z);
    this.group.rotation.y = -f.heading; // local +X = direction of travel; lamps face -X
    this.position.copy(this.group.position).y += 5;
    const b = new GeoBatch();
    const stop = signal.isStop;
    const keys: LampKey[] = stop ? ['Y', 'G', 'R', 'Y2'] : ['Y', 'G', 'Y2'];
    const top = 6.4, spacing = 0.42;
    const plateH = keys.length * spacing + 0.3;
    b.cyl(0.09, 0.11, top + 0.4, 8, mat(0, (top + 0.4) / 2, 0), '#d8d8d8', 'metal');
    b.box(0.06, plateH + 0.08, 0.68, mat(-0.12, top - plateH / 2 + 0.15, 0), '#f2f2f2');
    b.box(0.07, plateH, 0.6, mat(-0.14, top - plateH / 2 + 0.15, 0), '#0d0d0d');
    // ladder
    b.box(0.04, top - 0.4, 0.04, mat(0.2, (top - 0.4) / 2, 0.18), '#9a9a9a', 'metal');
    b.box(0.04, top - 0.4, 0.04, mat(0.2, (top - 0.4) / 2, -0.18), '#9a9a9a', 'metal');
    keys.forEach((k, i) => {
      const y = top - i * spacing;
      b.add(new THREE.CylinderGeometry(0.17, 0.17, 0.32, 10, 1, true, -Math.PI / 2, Math.PI), mat(-0.32, y + 0.02, 0, 0, 0, Math.PI / 2), '#0d0d0d');
      this.addLamp(k, -0.2, y, 0, 0.12, k === 'R' ? 'R' : k === 'G' ? 'G' : 'Y');
    });
    const sigPlate = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.32), labelMaterial(labelTexture(d.id, { bg: '#f2f2f2', fg: '#111', w: 192, h: 112 })));
    sigPlate.position.set(-0.2, top - plateH - 0.25, 0);
    sigPlate.rotation.y = -Math.PI / 2;
    this.group.add(sigPlate);
    if (!stop) {
      const p = new THREE.Mesh(new THREE.CircleGeometry(0.22, 16), labelMaterial(labelTexture('P', { bg: '#f5d000', fg: '#111', w: 128, h: 128 })));
      p.position.set(-0.2, top - plateH - 0.7, 0);
      p.rotation.y = -Math.PI / 2;
      this.group.add(p);
    }
    if (d.callingOn) {
      const y = top - plateH - 0.9;
      b.box(0.06, 0.5, 0.4, mat(-0.14, y, 0), '#0d0d0d');
      this.addLamp('C', -0.2, y, 0, 0.08, 'W');
      const c = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3), labelMaterial(labelTexture('C', { bg: '#111', fg: '#fff', w: 96, h: 96 })));
      c.position.set(-0.2, y - 0.45, 0);
      c.rotation.y = -Math.PI / 2;
      this.group.add(c);
    }
    if (d.routeIndicator) {
      // junction-type feather: 5 lunar-white lamps on an arm angled up to the left
      for (let i = 0; i < 5; i++) this.addLamp(`RI${i}`, -0.2, top + 0.45 + i * 0.22, -0.2 - i * 0.22, 0.06, 'W');
      b.box(0.05, 0.12, 1.3, mat(-0.15, top + 0.9, -0.6, 0, -0.78), '#0d0d0d');
    }
    this.group.add(b.build(materials() as unknown as Record<string, THREE.Material>));
  }

  private addLamp(key: LampKey, x: number, y: number, z: number, r: number, c: 'Y' | 'G' | 'R' | 'W') {
    const m = new THREE.MeshBasicMaterial({ color: 0x111111 });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8, 0, Math.PI), m);
    mesh.rotation.y = Math.PI; // hemisphere faces -X... (sphere segment opening faces +Z by default)
    mesh.rotation.z = 0;
    mesh.position.set(x, y, z);
    mesh.rotation.set(0, -Math.PI / 2, 0);
    this.group.add(mesh);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex.glow(), color: LAMP_COLORS[c], blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }));
    glow.position.set(x - 0.15, y, z);
    glow.visible = false;
    this.group.add(glow);
    this.lamps.set(key, { mesh, mat: m, glow, color: LAMP_COLORS[c] });
  }

  private set(key: LampKey, on: boolean) {
    const l = this.lamps.get(key);
    if (!l) return;
    if (on) l.mat.color.copy(l.color).multiplyScalar(5);
    else l.mat.color.setRGB(0.04, 0.04, 0.035);
    l.glow.visible = on;
  }

  /** Update lamp states and glow size for distance, night and fog. */
  update(camera: THREE.Vector3, night: number, fogDensity: number, blink: boolean) {
    const s = this.signal;
    const a = s.aspect;
    this.set('Y', a === 'Y' || a === 'YY');
    this.set('Y2', a === 'YY');
    this.set('G', a === 'G');
    this.set('R', a === 'R');
    this.set('C', s.callingOn && blink);
    for (let i = 0; i < 5; i++) this.set(`RI${i}`, !!s.routeIndicator);
    const dist = camera.distanceTo(this.position);
    // apparent glow grows with distance (stays visible), more at night and in fog
    const size = (0.35 + dist * 0.0028) * (0.6 + night * 0.9 + Math.min(1, fogDensity * 60) * 1.4);
    const fogVis = Math.exp(-Math.pow(fogDensity * dist * 0.42, 2));
    for (const l of this.lamps.values()) {
      l.glow.scale.setScalar(size);
      (l.glow.material as THREE.SpriteMaterial).opacity = Math.min(1, (0.35 + night * 0.65) * fogVis * 1.4);
    }
  }
}
