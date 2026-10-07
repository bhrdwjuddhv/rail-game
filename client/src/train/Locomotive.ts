import * as THREE from 'three/webgpu';
import { GeoBatch, mat } from '../core/GeoBatch';
import { canvasTexture, labelTexture } from '../core/Textures';
import { materials } from '../core/Materials';
import { CONTACT_H } from '../infrastructure/OHE';
import { LocoData, sectionsOf } from '@rail/shared/train/Consist';
import { GlbLevel, instanceLevel, loadLocoModel, poseRig } from './LocoModelLoader';

export const BODY_FLOOR = 1.25;  // underside of body above rail
export const ROOF_H = 4.05;      // roof above rail
export const WIDTH = 3.05;

/** LOD switch distances (m): full detail, body shell only, one box. */
export const LOCO_LOD = [0, 140, 600] as const;

type Style = NonNullable<LocoData['bodyStyle']>;

function liveryTexture(l: LocoData, variant: string, style: Style) {
  return canvasTexture(`livery-${l.id}-${variant}-${style}`, 2048, 256, (g, w, h) => {
    const body = variant === 'freight' && style === 'twin-cab' ? '#1f4e8c' : l.livery.body;
    const band = variant === 'freight' && style === 'twin-cab' ? '#f2f2f2' : l.livery.band;
    g.fillStyle = body; g.fillRect(0, 0, w, h);
    // roof strip (sampled by roof faces) and underframe strip
    g.fillStyle = l.livery.roof; g.fillRect(0, 0, w, 10);
    g.fillStyle = band; g.fillRect(0, h * 0.42, w, h * 0.16);
    g.fillStyle = '#f7f1e3'; g.fillRect(0, h * 0.62, w, 6);
    // louvres along the machine room
    g.fillStyle = 'rgba(0,0,0,0.35)';
    for (let x = w * 0.2; x < w * 0.8; x += 26) g.fillRect(x, h * 0.12, 16, h * 0.24);
    // cab doors and side windows: both ends (twin cab) or the front end only (one section of a twin loco)
    const doors = style === 'freight-section' ? [w * 0.955 - 70] : [w * 0.045, w * 0.955 - 70];
    for (const x of doors) {
      g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 3; g.strokeRect(x, h * 0.1, 70, h * 0.78);
      g.fillStyle = '#1b2228'; g.fillRect(x + 12, h * 0.14, 46, h * 0.22);
    }
    if (style === 'freight-section') { g.strokeStyle = 'rgba(0,0,0,0.5)'; g.strokeRect(6, h * 0.12, 40, h * 0.74); } // gangway door, inner end
    g.font = 'bold 44px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = body; g.fillText(l.operator.toUpperCase(), w * 0.5, h * 0.5);
    g.fillStyle = band; g.font = 'bold 30px Arial';
    g.fillText(`${l.name} ${l.number}`, w * 0.16, h * 0.76);
    g.fillText(`${l.name} ${l.number}`, w * 0.84, h * 0.76);
    // our own round logo
    for (const x of [w * 0.32, w * 0.68]) {
      g.fillStyle = band; g.beginPath(); g.arc(x, h * 0.26, 26, 0, Math.PI * 2); g.fill();
      g.fillStyle = body; g.font = 'bold 20px Arial'; g.fillText(l.livery.logoText, x, h * 0.265);
    }
  }, { repeat: false });
}

/** Side profile of the body (x along loco, y up): cabs at both ends, or (one section) at the front end only. */
function bodyShape(L: number, twin: boolean) {
  const s = new THREE.Shape();
  const h0 = BODY_FLOOR, h1 = 2.55, h2 = 3.75, h3 = ROOF_H;
  const half = L / 2;
  s.moveTo(-half, h0);
  s.lineTo(half, h0);
  s.lineTo(half, h1);
  s.lineTo(half - 0.42, h2);       // sloped windshield
  s.quadraticCurveTo(half - 0.6, h3, half - 1.0, h3);
  if (twin) {
    s.lineTo(-half + 1.0, h3);
    s.quadraticCurveTo(-half + 0.6, h3, -half + 0.42, h2);
    s.lineTo(-half, h1);
  } else {
    s.lineTo(-half + 0.15, h3);
    s.lineTo(-half, h3 - 0.15);    // square inner end with a rounded roof edge
  }
  s.lineTo(-half, h0);
  return s;
}

/** Extruded shell with livery UVs (sides map the livery strip, roof the roof colour). */
function shellGeometry(L: number, twin: boolean) {
  const geo = new THREE.ExtrudeGeometry(bodyShape(L, twin), { depth: WIDTH, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.04, bevelSegments: 1, curveSegments: 6 });
  geo.translate(0, 0, -WIDTH / 2);
  geo.computeVertexNormals();
  const pos = geo.attributes.position as THREE.BufferAttribute, nor = geo.attributes.normal as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const nz = Math.abs(nor.getZ(i)), ny = nor.getY(i);
    const v = (y - BODY_FLOOR) / (ROOF_H - BODY_FLOOR);
    if (nz > 0.6) uv.setXY(i, nor.getZ(i) > 0 ? (x + L / 2) / L : 1 - (x + L / 2) / L, v * 0.96);
    else if (ny > 0.6) uv.setXY(i, 0.5, 0.985);
    else uv.setXY(i, 0.01 + ((z + WIDTH / 2) / WIDTH) * 0.02, v * 0.96);
  }
  return geo;
}

/**
 * Procedural locomotive, one per loco section. Styles: "twin-cab" (WAP-7,
 * EP-7: one body, a cab at each end), "freight-section" (one section of a
 * twin-section loco like the WAG-12B: cab at the front end, gangway at the
 * inner end, its own pantograph, Bo bogies) and "diesel-hood" (WDM-3D: short
 * hood, cab, long hood with radiator fans and exhaust stack on a walkway
 * frame, Co bogies, no pantograph). The body is a THREE.LOD (full detail,
 * shell only, one box); bogies, wheelsets, pantographs and lights are shared
 * by every level. +X is the front (cab end).
 */
export class LocoModel {
  readonly group = new THREE.Group();
  readonly pantos: { lower: THREE.Object3D; upper: THREE.Object3D; head: THREE.Object3D; hinge: THREE.Vector3; base: THREE.Object3D }[] = [];
  readonly bogies: THREE.Object3D[] = [];
  readonly wheelsets: THREE.Object3D[] = [];
  /** the loco's 3D model (data.model) once loaded: one per LOD level */
  private glb: GlbLevel[] | null = null;
  /** our lamp meshes (repositioned onto a 3D model) */
  private lamps: { mesh: THREE.Object3D; end: number; z?: number }[] = [];
  private inCab = false;
  readonly headlight: THREE.SpotLight;
  readonly headlightTarget = new THREE.Object3D();
  readonly beam: THREE.Mesh;
  private headMat: THREE.MeshBasicMaterial;
  private markerMats: THREE.MeshBasicMaterial[] = [];
  private flasherMat: THREE.MeshBasicMaterial;
  /** always present: the cab interior and lights hang here; the LOD levels are inside */
  readonly body = new THREE.Group();
  readonly lod = new THREE.LOD();
  readonly length: number;
  readonly style: Style;
  /** diesel exhaust stack top (body coordinates), for the smoke */
  readonly stack: THREE.Vector3 | null = null;
  /** distance from the body centre to each bogie centre */
  readonly bogieX: number;

  constructor(readonly data: LocoData, variant: 'passenger' | 'freight' = 'passenger') {
    const n = sectionsOf(data);
    const L = data.lengthM / n;
    this.length = L;
    this.style = data.bodyStyle ?? 'twin-cab';
    this.bogieX = data.bogieCentresM / 2;
    const M = materials();
    const full = new THREE.Group(), mid = new THREE.Group();
    let headY = 3.95, headX = L / 2 - 0.62, markerY = 1.6;

    if (this.style === 'diesel-hood') {
      const d = this.dieselBody(L, full, mid);
      headY = d.headY; headX = d.headX;
      this.stack = new THREE.Vector3(data.diesel?.stackX ?? 1.6, d.stackTop, 0);
    } else {
      const twin = this.style === 'twin-cab';
      const shellMat = new THREE.MeshStandardMaterial({ map: liveryTexture(data, variant, this.style), roughness: 0.45, metalness: 0.25 });
      const geo = shellGeometry(L, twin);
      const shell = new THREE.Mesh(geo, shellMat);
      shell.castShadow = true; shell.receiveShadow = true;
      full.add(shell);
      mid.add(new THREE.Mesh(geo, shellMat));
      full.add(this.electricDetails(L, twin).build(M as unknown as Record<string, THREE.Material>));
      // pantographs: twin cab has two; a section of a twin loco has one, towards its inner end
      const pantoX = twin ? [L / 2 - 4.3, -(L / 2 - 4.3)] : [-(L / 2 - 3.6)];
      for (const x of pantoX) this.buildPanto(x, x > 0 ? 1 : -1);
      if (!twin) headX = L / 2 - 0.5;
    }
    // far: one box in the body colour
    const far = new THREE.Mesh(new THREE.BoxGeometry(L, ROOF_H - BODY_FLOOR + 0.3, WIDTH), new THREE.MeshStandardMaterial({ color: data.livery.body, roughness: 0.6 }));
    far.position.y = (ROOF_H + BODY_FLOOR - 0.3) / 2;
    this.lod.addLevel(full, LOCO_LOD[0]);
    this.lod.addLevel(mid, LOCO_LOD[1]);
    this.lod.addLevel(far, LOCO_LOD[2]);
    this.body.add(this.lod);

    // lights: headlight(s) and markers at the cab end(s)
    this.headMat = new THREE.MeshBasicMaterial({ color: 0x222222 });
    const ends = this.style === 'twin-cab' ? [1, -1] : [1];
    for (const end of ends) {
      const hl = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.12, 14), end > 0 ? this.headMat : new THREE.MeshBasicMaterial({ color: 0x222222 }));
      hl.rotation.z = Math.PI / 2;
      hl.position.set(end * headX, headY, 0);
      this.body.add(hl);
      this.lamps.push({ mesh: hl, end });
      for (const z of [-1.2, 1.2]) {
        const mm = new THREE.MeshBasicMaterial({ color: 0x222222 });
        const mk = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.06, 10), mm);
        mk.rotation.z = Math.PI / 2;
        mk.position.set(end * (L / 2 + 0.02), markerY, z);
        this.body.add(mk);
        this.lamps.push({ mesh: mk, end, z });
        this.markerMats.push(mm);
        (mm as THREE.MeshBasicMaterial & { end?: number }).end = end;
      }
    }
    this.flasherMat = new THREE.MeshBasicMaterial({ color: 0x332200 });
    const fl = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), this.flasherMat);
    fl.position.set(this.style === 'diesel-hood' ? headX - 0.3 : L / 2 - 1.4, this.style === 'diesel-hood' ? headY + 0.25 : ROOF_H + 0.12, 0);
    this.body.add(fl);

    this.headlight = new THREE.SpotLight(0xfff1d6, 0, 600, 0.26, 0.45, 1.2);
    this.headlight.position.set(headX + 0.2, headY - 0.05, 0);
    this.headlightTarget.position.set(L / 2 + 60, 0.5, 0);
    this.headlight.target = this.headlightTarget;
    this.body.add(this.headlight, this.headlightTarget);
    // volumetric-looking beam (visible in fog/night)
    const beamGeo = new THREE.ConeGeometry(9, 120, 20, 1, true);
    beamGeo.translate(0, -60, 0);
    beamGeo.rotateZ(Math.PI / 2);
    this.beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: 0xfff0d0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    this.beam.position.set(headX + 0.3, headY - 0.05, 0);
    this.beam.rotation.z = -0.03;
    this.beam.renderOrder = 10;
    this.body.add(this.beam);
    this.group.add(this.body);
    // a real 3D model replaces the procedural one when it has loaded (the procedural one stays if it fails)
    if (data.model) void loadLocoModel(data).then(t => { if (t) this.attachGlb(t); });

    // bogies + wheelsets (positioned per frame by TrainView): Bo (2 axles) or Co (3 axles)
    const perBogie = Math.max(2, Math.round(data.axles / (n * 2)));
    const axleX = Array.from({ length: perBogie }, (_, k) => (k - (perBogie - 1) / 2) * data.axleSpacingM);
    const frameL = data.axleSpacingM * (perBogie - 1) + 1.0;
    for (let i = 0; i < 2; i++) {
      const bg = new GeoBatch();
      bg.box(frameL, 0.45, 0.22, mat(0, 0.9, -1.05), '#2b2f33', 'metal');
      bg.box(frameL, 0.45, 0.22, mat(0, 0.9, 1.05), '#2b2f33', 'metal');
      for (const x of axleX) for (const z of [-1.05, 1.05]) {
        bg.box(0.38, 0.32, 0.32, mat(x, 0.55, z), '#1f2326', 'metal');          // axle box
        bg.cyl(0.11, 0.11, 0.38, 8, mat(x - 0.28, 0.88, z), '#a83232', 'metal'); // coil springs
        bg.cyl(0.11, 0.11, 0.38, 8, mat(x + 0.28, 0.88, z), '#a83232', 'metal');
      }
      bg.box(0.4, 0.3, 2.2, mat(-axleX[axleX.length - 1] / 2, 0.95, 0), '#2b2f33', 'metal');
      bg.box(0.4, 0.3, 2.2, mat(axleX[axleX.length - 1] / 2, 0.95, 0), '#2b2f33', 'metal');
      for (const x of axleX) bg.box(0.5, 0.6, 0.5, mat(x, 0.75, 0), '#25292c', 'metal'); // traction motors
      const bogie = bg.build(M as unknown as Record<string, THREE.Material>);
      for (const x of axleX) {
        const ws = wheelset(data.wheelDiameterM);
        ws.position.set(x, data.wheelDiameterM / 2, 0);
        bogie.add(ws);
        this.wheelsets.push(ws);
      }
      this.bogies.push(bogie);
      this.group.add(bogie);
    }
  }

  /** Underframe, ends, glazing, handrails and roof gear of the electric bodies. */
  private electricDetails(L: number, twin: boolean) {
    const b = new GeoBatch();
    const uf = this.data.livery.underframe;
    b.box(L - 0.6, 0.35, WIDTH - 0.1, mat(0, BODY_FLOOR - 0.15, 0), uf, 'metal');
    b.box(Math.min(5.5, L * 0.3), 0.7, 2.2, mat(0, BODY_FLOOR - 0.6, 0), '#2d3236', 'metal'); // transformer tank
    for (const end of twin ? [-1, 1] : [1, -1]) {
      const x = end * (L / 2);
      const cab = twin || end > 0;
      // buffer beam, buffers, CBC coupler, cowcatcher (inner end of a section: drawbar only)
      b.box(0.25, 0.6, WIDTH, mat(x - end * 0.1, 1.05, 0), cab ? '#d9b21c' : uf);
      if (!cab) { b.box(0.4, 0.2, 0.3, mat(x + end * 0.15, 0.95, 0), '#2a2a2a', 'metal'); continue; }
      for (const z of [-0.98, 0.98]) {
        b.cyl(0.11, 0.11, 0.45, 10, mat(x + end * 0.22, 1.05, z, 0, 0, Math.PI / 2), '#2a2a2a', 'metal');
        b.cyl(0.22, 0.22, 0.06, 14, mat(x + end * 0.46, 1.05, z, 0, 0, Math.PI / 2), '#3a3a3a', 'metal');
      }
      b.box(0.55, 0.22, 0.3, mat(x + end * 0.3, 0.95, 0), '#2a2a2a', 'metal');
      b.box(0.3, 0.45, WIDTH * 0.9, mat(x + end * 0.25, 0.45, 0, 0, 0, end * 0.35), '#3a3a3a', 'metal');
      for (const z of [-0.72, 0.72]) {
        const q = mat(x - end * 0.19, 3.15, z, end > 0 ? 0 : Math.PI).multiply(new THREE.Matrix4().makeRotationZ(0.33));
        b.box(0.03, 1.15, 1.25, q, '#1d2b33', 'glass');
      }
      for (const z of [-1, 1]) {
        const xd = x - end * 1.15;
        b.cyl(0.02, 0.02, 1.5, 6, mat(xd, 2.2, z * (WIDTH / 2 + 0.06)), '#c9c9c9', 'metal');
        b.cyl(0.02, 0.02, 1.5, 6, mat(xd - end * 0.7, 2.2, z * (WIDTH / 2 + 0.06)), '#c9c9c9', 'metal');
        for (const y of [0.55, 0.9]) b.box(0.5, 0.04, 0.25, mat(xd - end * 0.35, y, z * (WIDTH / 2 - 0.05)), '#888', 'metal');
      }
      b.box(0.02, 0.6, 0.03, mat(x - end * 0.13, 2.75, 0.2, 0, 0, 0.35 * end), '#111');
    }
    // roof equipment: busbars, VCB, insulators, blower covers
    b.box(L - 3, 0.12, 0.08, mat(0, ROOF_H + 0.12, -0.6), '#b87333', 'metal');
    b.box(L - 3, 0.12, 0.08, mat(0, ROOF_H + 0.12, 0.6), '#b87333', 'metal');
    b.box(1.6, 0.5, 1.0, mat(twin ? 0 : -1.5, ROOF_H + 0.25, 0), '#8a9096', 'metal');
    for (const x of [-1.2, 1.2, -2.8, 2.8]) b.cyl(0.09, 0.12, 0.35, 8, mat(x, ROOF_H + 0.17, 0.6), '#7a4a32');
    for (let x = -3.5; x <= 3.5; x += 1.4) b.box(1.0, 0.08, 2.2, mat(x, ROOF_H + 0.02, 0), '#4a4f53', 'metal');
    return b;
  }

  /**
   * WDM-3D style hood unit: a frame with walkways and handrails, short hood,
   * cab, long hood (radiator fans at the rear, exhaust stack), fuel tank.
   * Returns where the headlight and stack top are.
   */
  private dieselBody(L: number, full: THREE.Group, mid: THREE.Group) {
    const M = materials();
    const lv = this.data.livery, body = lv.body, band = lv.band, uf = lv.underframe;
    const cabFront = L / 2 - 3.1, cabBack = cabFront - 2.7;
    const hoodW = 2.55, frameY = 1.42;
    const b = new GeoBatch(), m = new GeoBatch();
    // frame + walkway, buffer beams, cowcatchers, buffers, couplers
    for (const g of [b, m]) g.box(L - 0.3, 0.32, WIDTH, mat(0, frameY - 0.16, 0), uf, 'metal');
    for (const end of [-1, 1]) {
      const x = end * (L / 2);
      b.box(0.25, 0.6, WIDTH, mat(x - end * 0.1, 1.05, 0), '#d9b21c');
      for (const z of [-0.98, 0.98]) {
        b.cyl(0.11, 0.11, 0.45, 10, mat(x + end * 0.22, 1.05, z, 0, 0, Math.PI / 2), '#2a2a2a', 'metal');
        b.cyl(0.22, 0.22, 0.06, 14, mat(x + end * 0.46, 1.05, z, 0, 0, Math.PI / 2), '#3a3a3a', 'metal');
      }
      b.box(0.55, 0.22, 0.3, mat(x + end * 0.3, 0.95, 0), '#2a2a2a', 'metal');
      b.box(0.3, 0.45, WIDTH * 0.9, mat(x + end * 0.25, 0.45, 0, 0, 0, end * 0.35), '#3a3a3a', 'metal');
      // end handrails
      b.box(0.04, 0.04, WIDTH - 0.2, mat(x - end * 0.12, frameY + 0.95, 0), '#e8e8e8', 'metal');
    }
    // side handrails along the walkway
    for (const z of [-1, 1]) {
      b.cyl(0.025, 0.025, L - 0.8, 6, mat(0, frameY + 0.95, z * (WIDTH / 2 - 0.05), 0, 0, Math.PI / 2), '#e8e8e8', 'metal');
      for (let x = -L / 2 + 0.6; x <= L / 2 - 0.6; x += 1.6) b.cyl(0.02, 0.02, 0.95, 6, mat(x, frameY + 0.48, z * (WIDTH / 2 - 0.05)), '#e8e8e8', 'metal');
    }
    // fuel tank and battery boxes between the bogies
    b.box(4.6, 0.9, 2.3, mat(0, frameY - 0.85, 0), '#2a2e31', 'metal');
    m.box(4.6, 0.9, 2.3, mat(0, frameY - 0.85, 0), '#2a2e31', 'metal');
    // hoods and cab (body colour with a band); full and mid share the shapes
    const hood = (g: GeoBatch, x0: number, x1: number, top: number, w: number) => {
      const len = x1 - x0, cx = (x0 + x1) / 2, h = top - frameY;
      g.box(len, h, w, mat(cx, frameY + h / 2, 0), body);
      g.box(len + 0.02, 0.22, w + 0.02, mat(cx, frameY + h * 0.55, 0), band);
      g.box(len - 0.1, 0.08, w - 0.25, mat(cx, top + 0.04, 0), lv.roof);
    };
    for (const g of [b, m]) {
      hood(g, cabFront + 0.05, L / 2 - 0.35, 2.95, 2.3);       // short hood
      hood(g, cabBack, cabFront, 4.05, WIDTH - 0.15);           // cab
      hood(g, -L / 2 + 0.35, cabBack - 0.05, 3.7, hoodW);       // long hood
    }
    // cab glazing (front, rear, sides) and doors
    for (const end of [1, -1]) {
      const x = end > 0 ? cabFront + 0.02 : cabBack - 0.02;
      for (const z of [-0.7, 0.7]) b.box(0.03, 0.85, 1.05, mat(x, 3.35, z), '#1d2b33', 'glass');
    }
    for (const z of [-1, 1]) {
      b.box(1.0, 0.75, 0.03, mat(cabFront - 1.0, 3.35, z * (WIDTH / 2 - 0.06)), '#1d2b33', 'glass');
      b.box(0.8, 1.9, 0.02, mat(cabFront - 2.05, frameY + 1.2, z * (WIDTH / 2 - 0.06)), '#7c2a1c');
    }
    // long hood: access doors / louvres down the sides, radiator grilles and two fans on the roof at the rear
    for (const z of [-1, 1]) for (let x = -L / 2 + 0.9; x < cabBack - 0.6; x += 1.15) {
      b.box(0.9, 1.5, 0.02, mat(x + 0.45, frameY + 1.15, z * (hoodW / 2 + 0.005)), '#9b3622');
      if (x < -L / 2 + 3.6) for (let y = 0; y < 6; y++) b.box(0.8, 0.04, 0.03, mat(x + 0.45, frameY + 0.6 + y * 0.2, z * (hoodW / 2 + 0.01)), '#2b2b2b');
    }
    for (const fx of [-L / 2 + 1.25, -L / 2 + 2.6]) {
      b.cyl(0.62, 0.62, 0.08, 18, mat(fx, 3.75, 0), '#2b2f33', 'metal');
      b.box(1.3, 0.02, 0.06, mat(fx, 3.8, 0, 0.4), '#555');
      b.box(1.3, 0.02, 0.06, mat(fx, 3.8, 0, -0.75), '#555');
    }
    // exhaust stack and silencer
    const sx = this.data.diesel?.stackX ?? 1.6;
    const stackX = Math.max(-L / 2 + 3.5, Math.min(cabBack - 1, sx));
    b.box(1.4, 0.35, 0.8, mat(stackX, 3.87, 0), '#3d4246', 'metal');
    b.cyl(0.17, 0.2, 0.45, 12, mat(stackX, 4.25, 0), '#26292c', 'metal');
    // horn and headlight housing on the short hood
    b.box(0.5, 0.35, 0.5, mat(L / 2 - 0.55, 3.12, 0), body);
    for (const z of [-0.25, 0.25]) b.cyl(0.05, 0.08, 0.35, 8, mat(cabFront + 0.2, 4.2, z, 0, 0, Math.PI / 2), '#888', 'metal');
    // number board on the long hood sides
    const plate = labelTexture(`${this.data.name} ${this.data.number}|hood`, { bg: lv.band, fg: '#1a1a1a', w: 512, h: 96, lines: [`${this.data.livery.logoText}  ${this.data.name}  ${this.data.number}`] });
    for (const z of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 0.6), new THREE.MeshStandardMaterial({ map: plate, roughness: 0.6 }));
      p.position.set(-L / 2 + 5.4, 2.55, z * (hoodW / 2 + 0.02));
      if (z < 0) p.rotation.y = Math.PI;
      full.add(p);
    }
    const mats = M as unknown as Record<string, THREE.Material>;
    full.add(b.build(mats));
    mid.add(m.build(mats, false));
    return { headX: L / 2 - 0.55, headY: 3.12, stackTop: 4.48 };
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
    const armMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.6, roughness: 0.4 });
    const lower = new THREE.Group();
    lower.position.copy(hinge);
    const la = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.07, 0.07), armMat);
    la.position.x = 0.875;
    lower.add(la);
    const upper = new THREE.Group();
    const ua = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.05, 0.05), armMat);
    ua.position.x = 0.9;
    upper.add(ua);
    const head = new THREE.Group();
    const hb = new GeoBatch();
    hb.box(0.08, 0.06, 1.9, mat(0, 0, 0), '#3a3a3a', 'metal');
    hb.box(0.08, 0.06, 1.9, mat(0.25, 0, 0), '#3a3a3a', 'metal');
    for (const z of [-1, 1]) hb.box(0.3, 0.04, 0.35, mat(0.12, -0.08, z * 1.05, 0, z * 0.5), '#3a3a3a', 'metal');
    head.add(hb.build(M as unknown as Record<string, THREE.Material>));
    base.add(lower, upper, head);
    this.body.add(base);
    this.pantos.push({ lower, upper, head, hinge, base });
  }

  /**
   * Swap the procedural exterior for the loaded 3D model: its three levels of
   * detail, its bogies (turned by TrainView), wheels and pantograph rigs. Our
   * lamps move to the positions in data.model.lights.
   */
  private attachGlb(t: Record<'near' | 'mid' | 'far', THREE.Group>) {
    const cfg = this.data.model!;
    const levels = (['near', 'mid', 'far'] as const).map(k => instanceLevel(t[k], cfg));
    this.lod.levels.length = 0;
    this.lod.clear();
    levels.forEach((l, i) => this.lod.addLevel(l.root, LOCO_LOD[i]));
    // bogies: pairs (front, rear) per level; TrainView positions them all, only the visible level's show
    for (const b of this.bogies) b.removeFromParent();
    this.bogies.length = 0;
    for (const l of levels) for (const b of l.bogies) { this.bogies.push(b); this.group.add(b); }
    this.wheelsets.length = 0;
    // the model's own rigged pantographs, or ours at the model's pantograph positions
    for (const p of this.pantos) p.base.removeFromParent();
    this.pantos.length = 0;
    for (const x of cfg.proceduralPantographs?.x ?? []) this.buildPanto(x, x > 0 ? 1 : -1);
    const [hx, hy] = cfg.lights.head, [mx, my, mz] = cfg.lights.markers;
    for (const l of this.lamps) {
      if (l.z === undefined) l.mesh.position.set(l.end * hx, hy, 0);
      else l.mesh.position.set(l.end * mx, my, Math.sign(l.z) * mz);
    }
    this.headlight.position.set(hx + 0.2, hy - 0.05, 0);
    this.beam.position.set(hx + 0.3, hy - 0.05, 0);
    this.glb = levels;
    this.setCabView(this.inCab);
    this.syncLod();
  }

  /** Only the bogies of the level of detail on show are drawn. */
  syncLod() {
    if (!this.glb) return;
    const cur = this.lod.getCurrentLevel();
    this.glb.forEach((l, i) => { for (const b of l.bogies) b.visible = i === cur && !this.inCab; });
  }

  /** Wheel rotation (procedural: about the lateral axis; a 3D model's wheels about their own axle). */
  spin(angle: number) {
    for (const ws of this.wheelsets) ws.rotation.z = angle;
    if (this.glb) for (const l of this.glb) for (const w of l.wheels) w.quaternion.copy(w.userData.restQ).multiply(_spinQ.setFromAxisAngle(_axleX, -angle));
  }

  /** The 3D model is loaded and brings its own cab for the first-person view (data.model.cab). */
  get usesModelCab() { return !!this.glb && !!this.data.model?.cab; }

  /**
   * In the driver's seat: undercarriage, pantographs and outer glass are not
   * drawn. With our procedural cab the 3D model is not drawn from the seat;
   * with the model's own cab (data.model.cab) it is, and our cab is not.
   */
  setCabView(inCab: boolean) {
    this.inCab = inCab;
    this.body.traverse(o => { if (o.name === 'glass') o.visible = !inCab; });
    for (const b of this.bogies) b.visible = !inCab;
    for (const pt of this.pantos) pt.base.visible = !inCab;
    const ownCab = this.usesModelCab;
    // a model without its own cab (data.model.cab) is not drawn from the driver's seat: our cab
    // interior is shown alone, so the model's body (often double-sided, with painted windows) never
    // closes in around the camera
    // (on the LOD itself: THREE.LOD sets its levels' visibility every frame)
    if (this.glb) this.lod.visible = !inCab || ownCab;
    if (this.glb) for (const l of this.glb) {
      for (const c of l.cab) c.visible = !inCab || ownCab;
      for (const r of l.pantos) { r.lower.visible = r.upper.visible = !inCab; }
    }
    this.syncLod();
  }

  /** pos 0 = down, 1 = touching the contact wire (no-op for a diesel). */
  setPantograph(pos: number) {
    if (this.glb) { for (const l of this.glb) for (const r of l.pantos) poseRig(r, pos); return; }
    if (!this.pantos.length) return;
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
      const front = (m as THREE.MeshBasicMaterial & { end?: number }).end! > 0;
      // front markers white when leading, red at the rear end
      if (!markers) m.color.setRGB(0.12, 0.12, 0.12);
      else if (front === reverser >= 0) m.color.setRGB(3, 3, 2.7);
      else m.color.setRGB(3.5, 0.15, 0.1);
    }
    const on = flasher && Math.sin(t * 9) > 0;
    this.flasherMat.color.setRGB(on ? 4 : 0.2, on ? 2.2 : 0.13, on ? 0.2 : 0);
  }

  setBeam(opacity: number) { (this.beam.material as THREE.Material).opacity = opacity; this.beam.visible = opacity > 0.001; }

  /** Triangles per LOD level (body only) and of the bogies + wheelsets. */
  triangles() {
    const count = (o: THREE.Object3D) => {
      let t = 0;
      o.traverse(c => { const g = (c as THREE.Mesh).geometry; if ((c as THREE.Mesh).isMesh && g) t += (g.index ? g.index.count : g.attributes.position.count) / 3; });
      return Math.round(t);
    };
    const run = new THREE.Group();
    for (const b of this.bogies) run.add(b.clone());
    return { lod: this.lod.levels.map(l => count(l.object)), running: count(run) };
  }
}

const _spinQ = new THREE.Quaternion(), _axleX = new THREE.Vector3(1, 0, 0);

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
