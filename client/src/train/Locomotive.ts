import * as THREE from 'three/webgpu';
import { GeoBatch, mat } from '../core/GeoBatch';
import { canvasTexture } from '../core/Textures';
import { materials } from '../core/Materials';
import { CONTACT_H } from '../infrastructure/OHE';
import type { LocoData } from '@rail/shared/train/Consist';

export const BODY_FLOOR = 1.25;  // underside of body above rail
export const ROOF_H = 4.05;      // roof above rail
export const WIDTH = 3.05;

function liveryTexture(l: LocoData, variant: string) {
  return canvasTexture(`livery-${l.id}-${variant}`, 2048, 256, (g, w, h) => {
    const body = variant === 'freight' ? '#1f4e8c' : l.livery.body;
    const band = variant === 'freight' ? '#f2f2f2' : l.livery.band;
    g.fillStyle = body; g.fillRect(0, 0, w, h);
    // roof strip (sampled by roof faces) and underframe strip
    g.fillStyle = l.livery.roof; g.fillRect(0, 0, w, 10);
    g.fillStyle = band; g.fillRect(0, h * 0.42, w, h * 0.16);
    g.fillStyle = '#f7f1e3'; g.fillRect(0, h * 0.62, w, 6);
    // louvres along the machine room
    g.fillStyle = 'rgba(0,0,0,0.35)';
    for (let x = w * 0.2; x < w * 0.8; x += 26) g.fillRect(x, h * 0.12, 16, h * 0.24);
    // cab doors and side windows at both ends
    for (const x of [w * 0.045, w * 0.955 - 70]) {
      g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 3; g.strokeRect(x, h * 0.1, 70, h * 0.78);
      g.fillStyle = '#1b2228'; g.fillRect(x + 12, h * 0.14, 46, h * 0.22);
    }
    g.fillStyle = band;
    g.font = 'bold 44px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = body; g.fillText(l.operator.toUpperCase(), w * 0.5, h * 0.5);
    g.fillStyle = band; g.font = 'bold 30px Arial';
    g.fillText(`${l.id.toUpperCase()} ${l.number}`, w * 0.16, h * 0.76);
    g.fillText(`${l.id.toUpperCase()} ${l.number}`, w * 0.84, h * 0.76);
    // round logo
    for (const x of [w * 0.32, w * 0.68]) {
      g.fillStyle = band; g.beginPath(); g.arc(x, h * 0.26, 26, 0, Math.PI * 2); g.fill();
      g.fillStyle = body; g.font = 'bold 20px Arial'; g.fillText(l.livery.logoText, x, h * 0.265);
    }
  }, { repeat: false });
}

/** Side profile of the twin-cab body (x along loco, y up). */
function bodyShape(L: number) {
  const s = new THREE.Shape();
  const h0 = BODY_FLOOR, h1 = 2.55, h2 = 3.75, h3 = ROOF_H;
  const half = L / 2;
  s.moveTo(-half, h0);
  s.lineTo(half, h0);
  s.lineTo(half, h1);
  s.lineTo(half - 0.42, h2);       // sloped windshield
  s.quadraticCurveTo(half - 0.6, h3, half - 1.0, h3);
  s.lineTo(-half + 1.0, h3);
  s.quadraticCurveTo(-half + 0.6, h3, -half + 0.42, h2);
  s.lineTo(-half, h1);
  s.lineTo(-half, h0);
  return s;
}

export class LocoModel {
  readonly group = new THREE.Group();
  readonly pantos: { lower: THREE.Object3D; upper: THREE.Object3D; head: THREE.Object3D; hinge: THREE.Vector3; base: THREE.Object3D }[] = [];
  readonly bogies: THREE.Object3D[] = [];
  readonly wheelsets: THREE.Object3D[] = [];
  readonly headlight: THREE.SpotLight;
  readonly headlightTarget = new THREE.Object3D();
  readonly beam: THREE.Mesh;
  private headMat: THREE.MeshBasicMaterial;
  private markerMats: THREE.MeshBasicMaterial[] = [];
  private flasherMat: THREE.MeshBasicMaterial;
  readonly body = new THREE.Group();
  readonly length: number;

  constructor(readonly data: LocoData, variant: 'passenger' | 'freight' = 'passenger') {
    const L = data.lengthM;
    this.length = L;
    const M = materials();
    // body shell
    const geo = new THREE.ExtrudeGeometry(bodyShape(L), { depth: WIDTH, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.04, bevelSegments: 1, curveSegments: 6 });
    geo.translate(0, 0, -WIDTH / 2);
    geo.computeVertexNormals();
    const pos = geo.attributes.position as THREE.BufferAttribute, nor = geo.attributes.normal as THREE.BufferAttribute;
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const nz = Math.abs(nor.getZ(i)), ny = nor.getY(i);
      const v = (y - BODY_FLOOR) / (ROOF_H - BODY_FLOOR);
      if (nz > 0.6) uv.setXY(i, nz > 0 && nor.getZ(i) > 0 ? (x + L / 2) / L : 1 - (x + L / 2) / L, v * 0.96 + 0.0);
      else if (ny > 0.6) uv.setXY(i, 0.5, 0.985);
      else uv.setXY(i, 0.01 + ((z + WIDTH / 2) / WIDTH) * 0.02, v * 0.96);
    }
    const bodyMat = new THREE.MeshStandardMaterial({ map: liveryTexture(data, variant), roughness: 0.45, metalness: 0.25 });
    const shell = new THREE.Mesh(geo, bodyMat);
    shell.castShadow = true; shell.receiveShadow = true;
    this.body.add(shell);

    const b = new GeoBatch();
    const uf = data.livery.underframe;
    b.box(L - 0.6, 0.35, WIDTH - 0.1, mat(0, BODY_FLOOR - 0.15, 0), uf, 'metal');
    b.box(5.5, 0.7, 2.2, mat(0, BODY_FLOOR - 0.6, 0), '#2d3236', 'metal'); // transformer tank
    b.box(2.2, 0.55, 2.4, mat(-4.8, BODY_FLOOR - 0.5, 0), '#33393e', 'metal');
    b.box(2.2, 0.55, 2.4, mat(4.8, BODY_FLOOR - 0.5, 0), '#33393e', 'metal');
    for (const end of [-1, 1]) {
      const x = end * (L / 2);
      // buffer beam, buffers, CBC coupler, cowcatcher
      b.box(0.25, 0.6, WIDTH, mat(x - end * 0.1, 1.05, 0), '#d9b21c');
      for (const z of [-0.98, 0.98]) {
        b.cyl(0.11, 0.11, 0.45, 10, mat(x + end * 0.22, 1.05, z, 0, 0, Math.PI / 2), '#2a2a2a', 'metal');
        b.cyl(0.22, 0.22, 0.06, 14, mat(x + end * 0.46, 1.05, z, 0, 0, Math.PI / 2), '#3a3a3a', 'metal');
      }
      b.box(0.55, 0.22, 0.3, mat(x + end * 0.3, 0.95, 0), '#2a2a2a', 'metal');
      b.box(0.3, 0.45, WIDTH * 0.9, mat(x + end * 0.25, 0.45, 0, 0, 0, end * 0.35), '#3a3a3a', 'metal');
      // windshield panes
      for (const z of [-0.72, 0.72]) {
        const q = mat(x - end * 0.19, 3.15, z, end > 0 ? 0 : Math.PI).multiply(new THREE.Matrix4().makeRotationZ(0.33));
        b.box(0.03, 1.15, 1.25, q, '#1d2b33', 'glass');
      }
      // handrails & steps by the cab doors
      for (const z of [-1, 1]) {
        const xd = x - end * 1.15;
        b.cyl(0.02, 0.02, 1.5, 6, mat(xd, 2.2, z * (WIDTH / 2 + 0.06)), '#c9c9c9', 'metal');
        b.cyl(0.02, 0.02, 1.5, 6, mat(xd - end * 0.7, 2.2, z * (WIDTH / 2 + 0.06)), '#c9c9c9', 'metal');
        for (const y of [0.55, 0.9]) b.box(0.5, 0.04, 0.25, mat(xd - end * 0.35, y, z * (WIDTH / 2 - 0.05)), '#888', 'metal');
      }
      // wipers (static outside; cab view has its own animated pair)
      b.box(0.02, 0.6, 0.03, mat(x - end * 0.13, 2.75, 0.2, 0, 0, 0.35 * end), '#111');
    }
    // roof equipment
    b.box(L - 3, 0.12, 0.08, mat(0, ROOF_H + 0.12, -0.6), '#b87333', 'metal');
    b.box(L - 3, 0.12, 0.08, mat(0, ROOF_H + 0.12, 0.6), '#b87333', 'metal');
    b.box(1.6, 0.5, 1.0, mat(0, ROOF_H + 0.25, 0), '#8a9096', 'metal'); // VCB
    for (const x of [-1.2, 1.2, -2.8, 2.8]) b.cyl(0.09, 0.12, 0.35, 8, mat(x, ROOF_H + 0.17, 0.6), '#7a4a32');
    for (let x = -3.5; x <= 3.5; x += 1.4) b.box(1.0, 0.08, 2.2, mat(x, ROOF_H + 0.02, 0), '#4a4f53', 'metal');
    this.body.add(b.build(M as unknown as Record<string, THREE.Material>));

    // lights
    this.headMat = new THREE.MeshBasicMaterial({ color: 0x222222 });
    for (const end of [1, -1]) {
      const hl = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.12, 14), end > 0 ? this.headMat : new THREE.MeshBasicMaterial({ color: 0x222222 }));
      hl.rotation.z = Math.PI / 2;
      hl.position.set(end * (L / 2 - 0.62), 3.95, 0);
      this.body.add(hl);
      for (const z of [-1.2, 1.2]) {
        const mm = new THREE.MeshBasicMaterial({ color: 0x222222 });
        const mk = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.06, 10), mm);
        mk.rotation.z = Math.PI / 2;
        mk.position.set(end * (L / 2 + 0.02), 1.6, z);
        (mk as any).end = end;
        this.body.add(mk);
        this.markerMats.push(mm);
        (mm as any).end = end;
      }
    }
    this.flasherMat = new THREE.MeshBasicMaterial({ color: 0x332200 });
    const fl = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), this.flasherMat);
    fl.position.set(L / 2 - 1.4, ROOF_H + 0.12, 0);
    this.body.add(fl);

    this.headlight = new THREE.SpotLight(0xfff1d6, 0, 600, 0.26, 0.45, 1.2);
    this.headlight.position.set(L / 2 - 0.4, 3.9, 0);
    this.headlightTarget.position.set(L / 2 + 60, 0.5, 0);
    this.headlight.target = this.headlightTarget;
    this.body.add(this.headlight, this.headlightTarget);
    // volumetric-looking beam (visible in fog/night)
    const beamGeo = new THREE.ConeGeometry(9, 120, 20, 1, true);
    beamGeo.translate(0, -60, 0);
    beamGeo.rotateZ(Math.PI / 2);
    this.beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: 0xfff0d0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    this.beam.position.set(L / 2 - 0.3, 3.9, 0);
    this.beam.rotation.z = -0.03;
    this.beam.renderOrder = 10;
    this.body.add(this.beam);

    // pantographs
    for (const x of [L / 2 - 4.3, -(L / 2 - 4.3)]) this.buildPanto(x, x > 0 ? 1 : -1);
    this.group.add(this.body);

    // bogies + wheelsets (positioned per frame by TrainView)
    for (let i = 0; i < 2; i++) {
      const bg = new GeoBatch();
      bg.box(4.9, 0.45, 0.22, mat(0, 0.9, -1.05), '#2b2f33', 'metal');
      bg.box(4.9, 0.45, 0.22, mat(0, 0.9, 1.05), '#2b2f33', 'metal');
      for (const x of [-1.95, 0, 1.95]) for (const z of [-1.05, 1.05]) {
        bg.box(0.38, 0.32, 0.32, mat(x, 0.55, z), '#1f2326', 'metal');          // axle box
        bg.cyl(0.11, 0.11, 0.38, 8, mat(x - 0.28, 0.88, z), '#a83232', 'metal'); // coil springs
        bg.cyl(0.11, 0.11, 0.38, 8, mat(x + 0.28, 0.88, z), '#a83232', 'metal');
      }
      bg.box(0.4, 0.3, 2.2, mat(-0.98, 0.95, 0), '#2b2f33', 'metal');
      bg.box(0.4, 0.3, 2.2, mat(0.98, 0.95, 0), '#2b2f33', 'metal');
      for (const x of [-1.95, 0, 1.95]) bg.box(0.5, 0.6, 0.5, mat(x, 0.75, 0), '#25292c', 'metal'); // traction motors
      const bogie = bg.build(M as unknown as Record<string, THREE.Material>);
      for (const x of [-1.95, 0, 1.95]) {
        const ws = wheelset(data.wheelDiameterM);
        ws.position.set(x, data.wheelDiameterM / 2, 0);
        bogie.add(ws);
        this.wheelsets.push(ws);
      }
      this.bogies.push(bogie);
      this.group.add(bogie);
    }
  }

  private buildPanto(x: number, dir: number) {
    const M = materials();
    const base = new THREE.Group();
    base.position.set(x, ROOF_H, 0);
    const b = new GeoBatch();
    for (const z of [-0.5, 0.5]) for (const dx of [-0.5, 0.5]) b.cyl(0.07, 0.09, 0.35, 8, mat(dx, 0.17, z), '#7a4a32');
    b.box(1.3, 0.08, 1.2, mat(0, 0.37, 0), '#5d6266', 'metal');
    base.add(b.build(M as unknown as Record<string, THREE.Material>));
    const hinge = new THREE.Vector3(-dir * 0.5, 0.42, 0);
    const lower = new THREE.Group();
    lower.position.copy(hinge);
    const la = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.07, 0.07), M.metal);
    la.position.x = 0.875;
    lower.add(la);
    const upper = new THREE.Group();
    const ua = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.05, 0.05), M.metal);
    ua.position.x = 0.9;
    upper.add(ua);
    const head = new THREE.Group();
    const hb = new GeoBatch();
    hb.box(0.08, 0.06, 1.9, mat(0, 0, 0), '#3a3a3a', 'metal');
    hb.box(0.08, 0.06, 1.9, mat(0.25, 0, 0), '#3a3a3a', 'metal');
    for (const z of [-1, 1]) hb.box(0.3, 0.04, 0.35, mat(0.12, -0.08, z * 1.05, 0, z * 0.5), '#3a3a3a', 'metal');
    head.add(hb.build(M as unknown as Record<string, THREE.Material>));
    // tint the arms with vertex-colour-free metal: give them a grey material
    (la.material as THREE.Material) = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.6, roughness: 0.4 });
    ua.material = la.material;
    base.add(lower, upper, head);
    this.body.add(base);
    this.pantos.push({ lower, upper, head, hinge, base });
  }

  /** pos 0 = down, 1 = touching the contact wire. */
  setPantograph(pos: number) {
    const hinge = this.pantos[0].hinge;
    const hDown = 0.18, hUp = CONTACT_H - ROOF_H - hinge.y;
    for (const p of this.pantos) {
      const h = hDown + (hUp - hDown) * pos;
      const dir = Math.sign(-p.hinge.x) || 1;
      const L1 = 1.75, L2 = 1.8;
      // head is above the base centre; elbow solves two-circle intersection
      const hx = -p.hinge.x, hy = h;
      const d = Math.hypot(hx, hy);
      const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
      const k = Math.sqrt(Math.max(0, L1 * L1 - a * a));
      const mx = (hx * a) / d, my = (hy * a) / d;
      const ex = mx - (hy * k) / d * dir, ey = my + (hx * k) / d * dir;
      p.lower.rotation.z = Math.atan2(ey, ex);
      p.upper.position.set(p.hinge.x + ex, p.hinge.y + ey, 0);
      p.upper.rotation.z = Math.atan2(hy - ey, hx - ex);
      p.head.position.set(-0.12, p.hinge.y + h + 0.05, 0);
    }
  }

  setLights(headlight: number, markers: boolean, flasher: boolean, t: number, reverser: number) {
    this.headMat.color.setRGB(headlight ? 4 : 0.13, headlight ? 3.8 : 0.13, headlight ? 3.4 : 0.13);
    this.headlight.intensity = headlight === 2 ? 2600 : headlight === 1 ? 700 : 0;
    for (const m of this.markerMats) {
      const front = (m as any).end > 0;
      // front markers white when leading, red at the rear end
      if (!markers) m.color.setRGB(0.12, 0.12, 0.12);
      else if (front === reverser >= 0) m.color.setRGB(3, 3, 2.7);
      else m.color.setRGB(3.5, 0.15, 0.1);
    }
    const on = flasher && Math.sin(t * 9) > 0;
    this.flasherMat.color.setRGB(on ? 4 : 0.2, on ? 2.2 : 0.13, on ? 0.2 : 0);
  }

  setBeam(opacity: number) { (this.beam.material as THREE.Material).opacity = opacity; this.beam.visible = opacity > 0.001; }
}

function wheelset(d: number) {
  const g = new THREE.Group();
  const M = materials();
  const b = new GeoBatch();
  for (const z of [-0.78, 0.78]) {
    b.cyl(d / 2, d / 2, 0.14, 18, mat(0, 0, z, 0, Math.PI / 2), '#3c3c3c', 'metal');
    b.cyl(d / 2 + 0.03, d / 2 + 0.03, 0.03, 18, mat(0, 0, z + Math.sign(z) * -0.075, 0, Math.PI / 2), '#555', 'metal');
    b.box(d * 0.7, 0.05, 0.02, mat(0, 0, z + Math.sign(z) * 0.075), '#777', 'metal'); // spoke marker so rotation is visible
  }
  b.cyl(0.09, 0.09, 1.9, 8, mat(0, 0, 0, 0, Math.PI / 2), '#2d2d2d', 'metal');
  g.add(b.build(M as unknown as Record<string, THREE.Material>));
  return g;
}

