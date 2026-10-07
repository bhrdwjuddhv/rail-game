import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GeoBatch, mat } from '../core/GeoBatch';
import { canvasTexture } from '../core/Textures';
import { materials } from '../core/Materials';
import { newFrame, RAIL_TOP, TrackFrame } from '@rail/shared/track/Chainage';
import type { Route } from '@rail/shared/track/Route';
import type { CoachData, LocoData, Vehicle } from '@rail/shared/train/Consist';
import { LocoModel } from './Locomotive';

const FLOOR = 1.15, TOP = 4.0, CW = 3.2;

function coachTextures(c: CoachData) {
  const draw = (lit: boolean) => (g: CanvasRenderingContext2D, w: number, h: number) => {
    const L = c.lengthM;
    const px = (m: number) => (m / L) * w;
    if (lit) { g.fillStyle = '#000'; g.fillRect(0, 0, w, h); }
    else {
      g.fillStyle = c.livery.body; g.fillRect(0, 0, w, h);
      g.fillStyle = c.livery.roof; g.fillRect(0, 0, w, 8);
      g.fillStyle = c.livery.band;
      g.fillRect(0, h * 0.66, w, h * 0.05);
      g.fillRect(0, h * 0.2, w, h * 0.035);
    }
    if (c.windows === 'none') {
      if (!lit) {
        g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 3;
        for (let x = 0; x < w; x += px(0.9)) { g.beginPath(); g.moveTo(x, 12); g.lineTo(x, h); g.stroke(); }
        g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(px(L / 2 - 1.5), h * 0.15, px(3), h * 0.8);
        g.fillStyle = '#f2f2f2'; g.font = 'bold 26px Arial'; g.textAlign = 'center'; g.fillText('BRN  BCN  118204', w / 2, h * 0.32);
      }
      return;
    }
    // doors at both ends
    for (const x of [px(1.1), px(L - 1.1) - px(0.9)]) {
      if (!lit) { g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(x, h * 0.12, px(0.9), h * 0.86); }
      g.fillStyle = lit ? c.interiorLight : '#1d2329'; g.fillRect(x + px(0.25), h * 0.42, px(0.4), h * 0.14);
    }
    // window row
    const sealed = c.windows === 'sealed';
    if (sealed) {
      g.fillStyle = lit ? c.interiorLight : c.livery.window;
      g.fillRect(px(2.4), h * 0.4, px(L - 4.8), h * 0.2);
    } else {
      for (let x = 2.6; x < L - 3.2; x += 1.55) {
        g.fillStyle = lit ? c.interiorLight : c.livery.window;
        g.fillRect(px(x), h * 0.38, px(1.1), h * 0.24);
        if (!lit) { g.fillStyle = 'rgba(200,200,200,0.5)'; for (let k = 1; k < 4; k++) g.fillRect(px(x) + (px(1.1) * k) / 4, h * 0.38, 2, h * 0.24); }
      }
    }
    if (!lit) {
      g.fillStyle = c.livery.band; g.font = 'bold 22px Arial'; g.textAlign = 'center';
      g.fillText(`BHARAT RAIL NETWORK   ${c.id === 'ac3' ? '3A' : c.id === 'sleeper' ? 'SL' : 'GS'}  ${c.id.toUpperCase()} 21${c.id.length}43`, w / 2, h * 0.8);
    }
  };
  const map = canvasTexture(`coach-${c.id}`, 1024, 128, draw(false), { repeat: false });
  const em = canvasTexture(`coach-${c.id}-lit`, 1024, 128, draw(true), { repeat: false });
  return { map, em };
}

const bodyCache = new Map<string, { body: THREE.BufferGeometry; under: THREE.BufferGeometry; mat: THREE.MeshStandardMaterial }>();
function coachTemplate(c: CoachData) {
  let t = bodyCache.get(c.id);
  if (t) return t;
  const goods = c.windows === 'none';
  const top = goods ? 3.6 : TOP, w = goods ? 3.0 : CW;
  const s = new THREE.Shape();
  s.moveTo(-w / 2, FLOOR);
  s.lineTo(w / 2, FLOOR);
  s.lineTo(w / 2, top - 0.5);
  s.quadraticCurveTo(w / 2, top, 0, top);
  s.quadraticCurveTo(-w / 2, top, -w / 2, top - 0.5);
  s.lineTo(-w / 2, FLOOR);
  const L = c.lengthM - 0.5;
  const geo = new THREE.ExtrudeGeometry(s, { depth: L, bevelEnabled: false, curveSegments: 5 });
  geo.rotateY(Math.PI / 2);
  geo.translate(-L / 2, 0, 0);
  geo.computeVertexNormals();
  const p = geo.attributes.position as THREE.BufferAttribute, n = geo.attributes.normal as THREE.BufferAttribute, uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), nz = n.getZ(i), ny = n.getY(i);
    const v = ((y - FLOOR) / (top - FLOOR)) * 0.96;
    if (Math.abs(nz) > 0.55) uv.setXY(i, nz > 0 ? (x + L / 2) / L : 1 - (x + L / 2) / L, v);
    else if (ny > 0.5) uv.setXY(i, 0.5, 0.985);
    else uv.setXY(i, 0.004, v);
  }
  const { map, em } = coachTextures(c);
  const material = new THREE.MeshStandardMaterial({ map, emissiveMap: em, emissive: new THREE.Color(c.interiorLight), emissiveIntensity: 0, roughness: 0.5, metalness: 0.15 });
  const b = new GeoBatch();
  b.box(L - 1, 0.3, w - 0.2, mat(0, FLOOR - 0.12, 0), '#26282a', 'metal');
  if (!goods) {
    b.box(3, 0.6, 2, mat(-2.5, FLOOR - 0.55, 0), '#303438', 'metal');
    b.box(2.2, 0.5, 1.6, mat(3.5, FLOOR - 0.5, 0), '#303438', 'metal');
    for (const e of [-1, 1]) b.box(0.4, 2.3, 1.3, mat(e * (L / 2 + 0.15), FLOOR + 1.2, 0), '#1c1c1c'); // gangway bellows
  }
  for (const e of [-1, 1]) b.box(0.5, 0.22, 0.3, mat(e * (L / 2 + 0.1), 0.95, 0), '#2a2a2a', 'metal'); // CBC
  t = { body: geo, under: b.geometry('metal')!, mat: material };
  // std parts (bellows) merged into under geometry via second key
  const stdPart = b.geometry('std');
  if (stdPart) t.under = mergeTwo(t.under, stdPart);
  bodyCache.set(c.id, t);
  return t;
}

function mergeTwo(a: THREE.BufferGeometry, b: THREE.BufferGeometry) {
  return mergeGeometries([a, b], false)!;
}

let coachBogieGeo: THREE.BufferGeometry | null = null;
let wheelGeo: THREE.BufferGeometry | null = null;
function coachBogie() {
  if (coachBogieGeo) return coachBogieGeo;
  const b = new GeoBatch();
  for (const z of [-1.0, 1.0]) b.box(3.4, 0.3, 0.18, mat(0, 0.75, z), '#2f3336');
  b.box(0.35, 0.28, 2.1, mat(0, 0.78, 0), '#2f3336');
  for (const x of [-1.28, 1.28]) for (const z of [-1.0, 1.0]) {
    b.box(0.32, 0.26, 0.3, mat(x, 0.48, z), '#1c1f21');
    b.cyl(0.12, 0.12, 0.3, 8, mat(x * 0.7, 0.98, z), '#c9a227');
  }
  for (const x of [-1.28, 1.28]) for (const z of [-0.55, 0.55]) b.cyl(0.32, 0.32, 0.06, 14, mat(x, 0.46, z, 0, Math.PI / 2), '#8b8f94'); // brake discs
  coachBogieGeo = b.geometry('std')!;
  return coachBogieGeo;
}
function coachWheelset() {
  if (wheelGeo) return wheelGeo;
  const b = new GeoBatch();
  for (const z of [-0.78, 0.78]) {
    b.cyl(0.46, 0.46, 0.13, 16, mat(0, 0, z, 0, Math.PI / 2), '#3a3a3a');
    b.box(0.6, 0.05, 0.02, mat(0, 0, z + Math.sign(z) * 0.07), '#777');
  }
  b.cyl(0.08, 0.08, 1.8, 8, mat(0, 0, 0, 0, Math.PI / 2), '#2d2d2d');
  wheelGeo = b.geometry('std')!;
  return wheelGeo;
}

const _f1 = newFrame(), _f2 = newFrame();
const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1), _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4(), _m3 = new THREE.Matrix4();

const _flip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

/**
 * Renders a whole train: each loco section as its own model (a twin-section
 * loco and a second loco in multiple are several), coaches and wagons as
 * instanced bodies/bogies/wheelsets (a handful of draw calls for 90 vehicles).
 * Each vehicle hangs between its two bogies, so it swings correctly on curves.
 */
export class TrainView {
  readonly group = new THREE.Group();
  /** the leading loco section (cab, lights, cameras) */
  readonly loco: LocoModel;
  /** every loco section, in train order */
  readonly locos: LocoModel[] = [];
  private bodies = new Map<string, { body: THREE.InstancedMesh; under: THREE.InstancedMesh; idx: number[] }>();
  private bogies: THREE.InstancedMesh;
  private wheels: THREE.InstancedMesh;
  wheelAngle = 0;
  /** world transforms of each vehicle body (for cameras, sound) */
  readonly vehicleMatrices: THREE.Matrix4[] = [];

  constructor(readonly vehicles: Vehicle[], loco: LocoData, coachTypes: Record<string, CoachData>, variant: 'passenger' | 'freight' = 'passenger') {
    for (const v of vehicles) if (v.kind === 'loco') { const m = new LocoModel(loco, variant); this.locos.push(m); this.group.add(m.group); }
    this.loco = this.locos[0];
    const coaches = vehicles.filter(v => v.kind === 'coach');
    const byType = new Map<string, number[]>();
    vehicles.forEach((v, i) => { if (v.kind !== 'coach') return; const l = byType.get(v.typeId) ?? []; l.push(i); byType.set(v.typeId, l); });
    const M = materials();
    for (const [type, idx] of byType) {
      const t = coachTemplate(coachTypes[type]);
      const body = new THREE.InstancedMesh(t.body, t.mat, idx.length);
      const under = new THREE.InstancedMesh(t.under, M.metal, idx.length);
      body.castShadow = under.castShadow = true; body.receiveShadow = true;
      body.frustumCulled = under.frustumCulled = false;
      this.group.add(body, under);
      this.bodies.set(type, { body, under, idx });
    }
    this.bogies = new THREE.InstancedMesh(coachBogie(), M.std, Math.max(1, coaches.length * 2));
    this.wheels = new THREE.InstancedMesh(coachWheelset(), M.metal, Math.max(1, coaches.length * 4));
    this.bogies.count = coaches.length * 2;
    this.wheels.count = coaches.length * 4;
    this.bogies.frustumCulled = this.wheels.frustumCulled = false;
    this.bogies.castShadow = true;
    this.group.add(this.bogies, this.wheels);
    for (let i = 0; i < vehicles.length; i++) this.vehicleMatrices.push(new THREE.Matrix4());
  }

  private railFrame(route: Route, km: number, offsetAt: (km: number) => number, out: TrackFrame) {
    route.alignment.sampleOffset(km * 1000, offsetAt(km), out);
    out.y += RAIL_TOP;
    return out;
  }

  /** Position everything for a train whose head is at headKm. */
  update(route: Route, headKm: number, offsetAt: (km: number) => number, distanceM: number, nightLight: number) {
    const head = this.railFrame(route, headKm, offsetAt, _f1);
    const ox = head.x, oy = head.y, oz = head.z;
    this.group.position.set(ox, oy, oz);
    this.wheelAngle = distanceM / 0.46;
    let bi = 0, wi = 0, li = 0;
    const vs = this.vehicles;
    for (let i = 0; i < vs.length; i++) {
      const v = vs[i];
      const c = headKm - (v.frontOffset + v.length / 2) / 1000;
      const kF = c + v.bogieCentres / 2000, kR = c - v.bogieCentres / 2000;
      const F = this.railFrame(route, kF, offsetAt, _f1);
      const fx = F.x, fy = F.y, fz = F.z, fh = F.heading, fc = F.cant;
      const R = this.railFrame(route, kR, offsetAt, _f2);
      const dx = fx - R.x, dy = fy - R.y, dz = fz - R.z;
      const yaw = Math.atan2(dz, dx), pitch = Math.atan2(dy, Math.hypot(dx, dz));
      const roll = (fc + R.cant) / 2;
      _e.set(roll, -yaw, pitch, 'YZX');
      _q.setFromEuler(_e);
      _p.set((fx + R.x) / 2 - ox, (fy + R.y) / 2 - oy, (fz + R.z) / 2 - oz);
      _m.compose(_p, _q, _s);
      this.vehicleMatrices[i].copy(_m).setPosition(_p.x + ox, _p.y + oy, _p.z + oz);
      if (v.kind === 'loco') {
        const lm = this.locos[li++];
        // a reversed section (the rear half of a twin loco) faces backwards: its cab end at the rear
        lm.group.position.copy(_p);
        lm.group.quaternion.copy(_q);
        if (v.reversed) lm.group.quaternion.multiply(_flip);
        // bogies relative to body: yaw difference only (model front bogie first)
        const turn = v.reversed ? Math.PI : 0;
        const bogieH = v.reversed ? [R.heading + turn, fh + turn] : [fh, R.heading];
        // bogies come in (front, rear) pairs - a 3D model has a pair per level of detail
        lm.bogies.forEach((b, k) => {
          b.position.set((k % 2 === 0 ? 1 : -1) * v.bogieCentres / 2, 0, 0);
          b.rotation.set(0, -(bogieH[k % 2] - yaw - turn), 0);
        });
        lm.spin(-this.wheelAngle * (0.46 / (lm.data.wheelDiameterM / 2)) * (v.reversed ? -1 : 1));
        lm.syncLod();
        continue;
      }
      const set = this.bodies.get(v.typeId)!;
      const slot = set.idx.indexOf(i);
      set.body.setMatrixAt(slot, _m);
      set.under.setMatrixAt(slot, _m);
      // bogies and wheelsets
      for (const [k, h, bc] of [[0, fh, fc], [1, R.heading, R.cant]] as const) {
        const fr = k === 0 ? { x: fx, y: fy, z: fz } : { x: R.x, y: R.y, z: R.z };
        _e.set(bc, -h, pitch, 'YZX');
        _q.setFromEuler(_e);
        _p.set(fr.x - ox, fr.y - oy, fr.z - oz);
        _m2.compose(_p, _q, _s);
        this.bogies.setMatrixAt(bi++, _m2);
        for (const ax of [-v.axleSpacing / 2, v.axleSpacing / 2]) {
          _m3.makeRotationZ(-this.wheelAngle).setPosition(ax, 0.46, 0);
          this.wheels.setMatrixAt(wi++, _m.copy(_m2).multiply(_m3));
        }
      }
      (set.body.material as THREE.MeshStandardMaterial).emissiveIntensity = nightLight;
    }
    for (const s of this.bodies.values()) { s.body.instanceMatrix.needsUpdate = true; s.under.instanceMatrix.needsUpdate = true; }
    this.bogies.instanceMatrix.needsUpdate = true;
    this.wheels.instanceMatrix.needsUpdate = true;
  }
}
