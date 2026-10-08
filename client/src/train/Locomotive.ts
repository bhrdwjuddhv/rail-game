import * as THREE from 'three/webgpu';
import { GeoBatch, mat } from '../core/GeoBatch';
import { canvasTexture } from '../core/Textures';
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
    let headY = 3.95, headX = L / 2 - 0.62, markerY = 1.6, lampZ = [0];

    if (this.style === 'diesel-hood') {
      const d = this.dieselBody(L, full, mid);
      headY = d.headY; headX = d.headX; lampZ = d.lampZ;
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
      // one headlight, or a twin lamp (diesel hood units)
      const r = lampZ.length > 1 ? 0.13 : 0.2;
      for (const lz of lampZ) {
        const hl = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.12, 14), end > 0 ? this.headMat : new THREE.MeshBasicMaterial({ color: 0x222222 }));
        hl.rotation.z = Math.PI / 2;
        hl.position.set(end * headX, headY, lz);
        this.body.add(hl);
        this.lamps.push({ mesh: hl, end });
      }
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
   * WDM-3D style hood unit (Alco family look): a frame with walkways and white
   * handrails, red buffer beams with round buffers, a low short hood with a
   * twin headlight on top, an upright cab with small barred windows and horns
   * on the roof, and a long hood of louvred doors with radiator grilles and
   * fans at the rear. Blue body with a white band; numbers painted in yellow.
   * Returns where the headlight(s) and stack top are.
   */
  private dieselBody(L: number, full: THREE.Group, mid: THREE.Group) {
    const M = materials();
    const lv = this.data.livery, body = lv.body, band = lv.band, uf = lv.underframe;
    const beam = lv.bufferBeam ?? '#d9b21c', rail = '#ecebe6', dark = '#1e2326';
    const cabFront = L / 2 - 3.1, cabBack = cabFront - 2.7;
    const hoodW = 2.55, frameY = 1.42, shortTop = 3.0, cabTop = 4.0, longTop = 3.62;
    const bandY = 2.6, bandH = 0.3;
    const winLo = 2.95, winHi = 3.7, winMid = (winLo + winHi) / 2;
    const b = new GeoBatch(), m = new GeoBatch();

    // frame and walkway with a white edge stripe
    for (const g of [b, m]) g.box(L - 0.3, 0.32, WIDTH, mat(0, frameY - 0.16, 0), uf, 'metal');
    for (const z of [-1, 1]) b.box(L - 0.3, 0.07, 0.02, mat(0, frameY - 0.05, z * (WIDTH / 2 + 0.005)), rail);
    for (const end of [-1, 1]) {
      const x = end * (L / 2);
      // red buffer beam, round buffers, centre coupler with brake hoses, pilot
      for (const g of [b, m]) g.box(0.28, 0.78, WIDTH, mat(x - end * 0.12, 1.02, 0), beam);
      for (const z of [-0.98, 0.98]) {
        b.cyl(0.13, 0.15, 0.42, 12, mat(x + end * 0.2, 1.05, z, 0, 0, Math.PI / 2), beam, 'metal');
        b.cyl(0.24, 0.24, 0.07, 18, mat(x + end * 0.44, 1.05, z, 0, 0, Math.PI / 2), beam, 'metal');
        b.cyl(0.17, 0.17, 0.075, 16, mat(x + end * 0.445, 1.05, z, 0, 0, Math.PI / 2), '#b42419', 'metal');
      }
      b.box(0.55, 0.24, 0.32, mat(x + end * 0.3, 0.95, 0), '#2a2a2a', 'metal');
      for (const z of [-0.45, 0.45]) b.cyl(0.035, 0.035, 0.5, 6, mat(x + end * 0.12, 0.75, z, 0, 0, end * 0.5), z < 0 ? '#c83a2a' : '#e2c13a', 'metal');
      b.box(0.3, 0.5, WIDTH * 0.92, mat(x + end * 0.2, 0.42, 0, 0, 0, end * 0.35), '#2f3336', 'metal');
      // end handrail and corner steps up to the walkway
      b.box(0.04, 0.04, WIDTH - 0.2, mat(x - end * 0.2, frameY + 0.95, 0), rail, 'metal');
      for (const z of [-1, 1]) {
        b.cyl(0.025, 0.025, 0.95, 6, mat(x - end * 0.2, frameY + 0.48, z * (WIDTH / 2 - 0.1)), rail, 'metal');
        for (let k = 0; k < 3; k++) b.box(0.45, 0.04, 0.3, mat(x - end * 0.6, 0.55 + k * 0.3, z * (WIDTH / 2 - 0.12)), '#d9b21c', 'metal');
      }
    }
    // walkway railings: white posts and two rails
    for (const z of [-1, 1]) {
      for (const y of [0.55, 0.95]) b.cyl(0.022, 0.022, L - 1.0, 6, mat(0, frameY + y, z * (WIDTH / 2 - 0.05), 0, 0, Math.PI / 2), rail, 'metal');
      for (let x = -L / 2 + 0.5; x <= L / 2 - 0.5; x += 1.45) b.cyl(0.02, 0.02, 0.95, 6, mat(x, frameY + 0.48, z * (WIDTH / 2 - 0.05)), rail, 'metal');
    }
    // fuel tank between the bogies, air reservoirs beside it
    for (const g of [b, m]) g.box(4.6, 0.95, 2.3, mat(0, frameY - 0.85, 0), '#3a3f43', 'metal');
    for (const z of [-1.3, 1.3]) b.cyl(0.18, 0.18, 2.6, 10, mat(0, 0.95, z, 0, 0, Math.PI / 2), '#2d3134', 'metal');

    // hoods and cab: blue with the white band along the whole body; mid shares the shapes
    const hood = (g: GeoBatch, x0: number, x1: number, top: number, w: number) => {
      const len = x1 - x0, cx = (x0 + x1) / 2, h = top - frameY;
      g.box(len, h, w, mat(cx, frameY + h / 2, 0), body);
      // the band as thin plates round the sides and ends (a solid slab would show inside the cab)
      for (const z of [-1, 1]) g.box(len + 0.02, bandH, 0.02, mat(cx, bandY, z * (w / 2 + 0.005)), band);
      for (const x of [x0, x1]) g.box(0.02, bandH, w + 0.02, mat(x + (x === x0 ? -0.005 : 0.005), bandY, 0), band);
      g.box(len + 0.06, 0.07, w + 0.06, mat(cx, top + 0.02, 0), lv.roof);
    };
    for (const g of [b, m]) {
      hood(g, cabFront + 0.05, L / 2 - 0.42, shortTop, 2.2);
      hood(g, cabBack, cabFront, cabTop, WIDTH - 0.15);
      hood(g, -L / 2 + 0.42, cabBack - 0.05, longTop, hoodW);
    }
    // short hood: bevelled top front, twin headlight housing, sand box lids
    b.box(0.32, 0.32, 2.2, mat(L / 2 - 0.5, shortTop - 0.12, 0, 0, 0, Math.PI / 4), body);
    b.box(0.5, 0.36, 0.9, mat(L / 2 - 0.62, shortTop + 0.18, 0), body);
    b.box(0.52, 0.06, 0.94, mat(L / 2 - 0.62, shortTop + 0.38, 0), lv.roof);
    for (const z of [-0.22, 0.22]) b.cyl(0.15, 0.15, 0.06, 16, mat(L / 2 - 0.4, shortTop + 0.18, z, 0, 0, Math.PI / 2), '#1b1b1b', 'metal');
    for (const z of [-0.75, 0.75]) b.box(0.4, 0.05, 0.35, mat(cabFront + 0.5, shortTop + 0.03, z), '#2f3336', 'metal');
    // cab roof with a slight crown, horns on top (one facing each way)
    b.box(2.9, 0.1, WIDTH - 0.35, mat((cabBack + cabFront) / 2, cabTop + 0.1, 0), lv.roof);
    for (const [z, dir] of [[-0.32, 1], [0.32, -1]] as const) {
      b.box(0.08, 0.14, 0.08, mat(cabFront - 0.45, cabTop + 0.21, z), '#555b60', 'metal');
      b.add(new THREE.CylinderGeometry(0.1, 0.035, 0.5, 12), mat(cabFront - 0.45 + dir * 0.22, cabTop + 0.3, z, 0, 0, -dir * Math.PI / 2), '#9aa0a5', 'metal');
    }
    // cab windows: two small fronts with guard bars, two rear, sliding side windows
    for (const z of [-0.71, 0.71]) {
      b.box(0.03, winHi - winLo, 0.95, mat(cabFront + 0.02, winMid, z), '#1d2b33', 'glass');
      b.box(0.03, winHi - winLo, 0.95, mat(cabBack - 0.02, winMid, z), '#1d2b33', 'glass');
      for (const y of [winLo, winHi]) b.box(0.06, 0.05, 1.0, mat(cabFront + 0.03, y, z), dark);
      for (const k of [-1, 0, 1]) b.cyl(0.012, 0.012, winHi - winLo, 6, mat(cabFront + 0.07, winMid, z + k * 0.24), '#2a2f2c', 'metal');
    }
    for (const z of [-1, 1]) {
      const zs = z * ((WIDTH - 0.15) / 2);
      b.box(1.2, winHi - winLo, 0.03, mat(cabFront - 1.85, winMid, zs + z * 0.005), '#1d2b33', 'glass');
      b.box(1.26, 0.05, 0.05, mat(cabFront - 1.85, winLo, zs + z * 0.02), dark);
      b.box(0.04, 0.6, 0.04, mat(cabFront - 0.25, 2.2, zs + z * 0.05), rail, 'metal');   // grab handle
    }
    // long hood: louvred access doors, radiator grilles at the rear, grab rails along the sides
    const doorH = longTop - frameY - 0.35;
    for (const z of [-1, 1]) {
      const zs = z * (hoodW / 2 + 0.006);
      for (let x = -L / 2 + 0.75; x < cabBack - 0.6; x += 1.15) {
        const rad = x < -L / 2 + 3.4;
        b.box(0.02, doorH, 0.012, mat(x - 0.02, frameY + 0.2 + doorH / 2, zs), dark);   // door seam
        b.box(0.05, 0.12, 0.03, mat(x + 0.9, frameY + 1.2, zs), '#c9c9c9', 'metal');    // handle
        const rows = rad ? 9 : 4, top = rad ? longTop - 0.25 : bandY - 0.25;
        for (let r = 0; r < rows; r++) b.box(0.9, 0.035, 0.03, mat(x + 0.55, top - r * 0.11, zs), '#163055');
      }
      const r0 = -L / 2 + 0.8, r1 = cabBack - 0.8;
      b.cyl(0.02, 0.02, r1 - r0, 6, mat((r0 + r1) / 2, 3.05, z * (hoodW / 2 + 0.07), 0, 0, Math.PI / 2), rail, 'metal');
      for (let x = r0; x <= r1 + 0.01; x += (r1 - r0) / 4) b.box(0.03, 0.03, 0.08, mat(x, 3.05, z * (hoodW / 2 + 0.035)), rail, 'metal');
    }
    // roof: radiator fans and grilles at the rear, hatches, exhaust silencer and stack
    for (const fx of [-L / 2 + 1.35, -L / 2 + 2.75]) {
      b.cyl(0.6, 0.6, 0.1, 20, mat(fx, longTop + 0.07, 0), '#22272b', 'metal');
      for (const a of [0, 1.05, 2.1]) b.box(1.1, 0.02, 0.07, mat(fx, longTop + 0.13, 0, a), '#5a6066', 'metal');
    }
    for (let x = -L / 2 + 3.6; x < cabBack - 1.9; x += 1.7) b.box(1.4, 0.05, hoodW - 0.5, mat(x + 0.7, longTop + 0.04, 0), '#3b4247', 'metal');
    const sx = this.data.diesel?.stackX ?? 1.6;
    const stackX = Math.max(-L / 2 + 3.8, Math.min(cabBack - 1, sx));
    b.box(1.4, 0.35, 0.8, mat(stackX, longTop + 0.2, 0), '#3d4246', 'metal');
    b.cyl(0.17, 0.2, 0.45, 12, mat(stackX, longTop + 0.6, 0), '#26292c', 'metal');
    // rear end of the long hood: an unlit twin headlight
    b.box(0.3, 0.32, 0.85, mat(-L / 2 + 0.3, longTop - 0.3, 0), body);
    for (const z of [-0.22, 0.22]) b.cyl(0.14, 0.14, 0.05, 16, mat(-L / 2 + 0.14, longTop - 0.3, z, 0, 0, Math.PI / 2), '#2a2a2a', 'metal');

    // painted numbers in yellow (short hood front, cab sides, rear) and our round logo on the long hood
    const yellow = lv.numbers ?? '#f2c418';
    const num = `${this.data.number} ${this.data.name.replace(/[^A-Z0-9]/gi, '')}`;
    const paint = (key: string, w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void) =>
      new THREE.MeshStandardMaterial({ map: canvasTexture(key, w, h, draw, { repeat: false }), transparent: true, alphaTest: 0.35, roughness: 0.5 });
    const text = (g: CanvasRenderingContext2D, w: number, h: number, t: string, px: number) => {
      g.clearRect(0, 0, w, h); g.fillStyle = yellow; g.font = `bold ${px}px Arial`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(t, w / 2, h / 2 + 2);
    };
    const numMat = paint(`dnum-${num}-${yellow}`, 512, 96, (g, w, h) => text(g, w, h, num, 70));
    const endNum = paint(`dnum-end-${this.data.number}-${yellow}`, 256, 96, (g, w, h) => text(g, w, h, this.data.number, 72));
    const logoMat = paint(`dlogo-${lv.logoText}-${yellow}-${body}`, 128, 128, (g, w, h) => {
      g.clearRect(0, 0, w, h); g.fillStyle = yellow; g.beginPath(); g.arc(w / 2, h / 2, 60, 0, Math.PI * 2); g.fill();
      g.fillStyle = body; g.beginPath(); g.arc(w / 2, h / 2, 50, 0, Math.PI * 2); g.fill();
      g.fillStyle = yellow; g.font = 'bold 34px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(lv.logoText, w / 2, h / 2 + 2);
    });
    const decal = (mm: THREE.Material, w: number, h: number, x: number, y: number, z: number, ry: number) => {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mm);
      p.position.set(x, y, z); p.rotation.y = ry;
      full.add(p);
    };
    for (const z of [-1, 1]) {
      decal(numMat, 2.3, 0.43, cabFront - 1.35, 2.2, z * ((WIDTH - 0.15) / 2 + 0.012), z > 0 ? 0 : Math.PI);
      decal(logoMat, 0.75, 0.75, -1.2, 2.05, z * (hoodW / 2 + 0.02), z > 0 ? 0 : Math.PI);
    }
    decal(endNum, 1.0, 0.38, L / 2 - 0.41, 2.15, 0, Math.PI / 2);
    decal(endNum, 1.0, 0.38, -L / 2 + 0.41, 2.15, 0, -Math.PI / 2);

    const mats = M as unknown as Record<string, THREE.Material>;
    full.add(b.build(mats));
    mid.add(m.build(mats, false));
    return { headX: L / 2 - 0.36, headY: shortTop + 0.18, stackTop: longTop + 0.83, lampZ: [-0.22, 0.22] };
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
    // lamp housings sit on the outside of the nose: from inside a model cab they would show through the glass
    for (const l of this.lamps) l.mesh.visible = !(inCab && this.usesModelCab);
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
