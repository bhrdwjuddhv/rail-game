import * as THREE from 'three/webgpu';
import { clamp } from '@rail/shared/util';
import { newFrame } from '@rail/shared/track/Chainage';
import type { CameraContext, CameraMode, Pose } from '../camera/CameraManager';
import { lookAtQuat } from '../camera/CameraManager';
import type { SceneFile } from '@rail/shared/record/SceneFile';
import type { CamTarget, Studio } from './host';
import type { RecordTrains, TrainRef } from './RecordTrains';

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _e = new THREE.Euler();
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export type Shake = 'none' | 'light' | 'handheld';

/** Camera shake: a steady engine buzz (light) or a hand-held wander, from sums of sines (smooth, no randomness to flicker). */
function shake(kind: Shake, t: number, speed: number, pos: THREE.Vector3, quat: THREE.Quaternion) {
  if (kind === 'none') return;
  const s = (a: number, f: number, p: number) => a * Math.sin(t * f + p);
  if (kind === 'light') {
    const k = 0.25 + Math.min(1, Math.abs(speed) / 30);
    pos.y += (s(0.012, 31, 0) + s(0.008, 47, 1.3)) * k;
    pos.x += s(0.006, 23, 2.1) * k;
    _e.set(s(0.0015, 29, 0.4) * k, 0, s(0.002, 37, 0.9) * k);
  } else {
    pos.x += s(0.03, 0.9, 0) + s(0.015, 2.3, 1.2);
    pos.y += s(0.025, 1.3, 0.7) + s(0.01, 3.1, 2.0);
    _e.set(s(0.006, 0.7, 0.3) + s(0.003, 2.9, 1.0), s(0.008, 0.5, 2.2) + s(0.003, 2.1, 0.6), s(0.005, 0.8, 1.7));
  }
  quat.multiply(_q.setFromEuler(_e));
}

/** Free-flying drone: WASD, Q/E down / up, drag to look, Shift fast, Ctrl slow, wheel sets the speed. */
export class DroneCam implements CameraMode {
  readonly name = 'Drone';
  readonly near = 0.2;
  pos = new THREE.Vector3();
  private vel = new THREE.Vector3();
  yaw = 0; pitch = 0; private roll = 0;
  private tYaw = 0; private tPitch = 0;
  /** base speed (m/s), scroll changes it */
  speed = 20;
  /** 0 = snappy, 1 = floaty */
  smooth = 0.5;
  level = true;
  enter(_c: CameraContext, from: Pose) {
    this.pos.copy(from.pos);
    _e.setFromQuaternion(from.quat, 'YXZ');
    this.yaw = this.tYaw = _e.y; this.pitch = this.tPitch = _e.x; this.vel.set(0, 0, 0);
  }
  place(pos: THREE.Vector3, quat: THREE.Quaternion) {
    this.pos.copy(pos);
    _e.setFromQuaternion(quat, 'YXZ');
    this.yaw = this.tYaw = _e.y; this.pitch = this.tPitch = _e.x; this.vel.set(0, 0, 0);
  }
  drag(dx: number, dy: number) { this.tYaw -= dx * 0.0035; this.tPitch = clamp(this.tPitch - dy * 0.0035, -1.55, 1.55); }
  wheel(dy: number) { this.speed = clamp(this.speed * (dy > 0 ? 0.85 : 1.18), 1, 400); }
  update(ctx: CameraContext, out: Pose) {
    const k = ctx.keys, dt = ctx.dt;
    const mult = k('ShiftLeft') || k('ShiftRight') ? 4 : k('ControlLeft') || k('ControlRight') ? 0.25 : 1;
    const fwd = _v.set(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    const right = _v2.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const want = new THREE.Vector3();
    if (k('KeyW')) want.add(fwd); if (k('KeyS')) want.sub(fwd);
    if (k('KeyD')) want.add(right); if (k('KeyA')) want.sub(right);
    if (k('KeyE')) want.y += 1; if (k('KeyQ')) want.y -= 1;
    if (want.lengthSq() > 0) want.normalize().multiplyScalar(this.speed * mult);
    const a = 1 - Math.exp(-dt * (1.5 + 14 * (1 - this.smooth)));
    this.vel.lerp(want, a);
    this.pos.addScaledVector(this.vel, dt);
    const g = ctx.field.height(this.pos.x, this.pos.z);
    if (this.pos.y < g + 0.5) this.pos.y = g + 0.5;
    const yawRate = (this.tYaw - this.yaw) / Math.max(dt, 1e-3);
    const b = 1 - Math.exp(-dt * (2 + 20 * (1 - this.smooth)));
    this.yaw += (this.tYaw - this.yaw) * b;
    this.pitch += (this.tPitch - this.pitch) * b;
    // banking into turns unless the horizon is held level
    this.roll += ((this.level ? 0 : clamp(-yawRate * 0.08 - this.vel.dot(right) * 0.004, -0.35, 0.35)) - this.roll) * b;
    out.pos.copy(this.pos);
    out.quat.setFromEuler(_e.set(this.pitch, this.yaw, this.roll, 'YXZ'));
    out.fov = 55;
  }
}

/** Orbit round the selected train: drag to turn, wheel to zoom, optional slow auto orbit. */
export class OrbitCam implements CameraMode {
  readonly name = 'Orbit';
  readonly near = 0.2;
  az = 0.8; el = 0.35; dist = 45;
  /** degrees per second */
  auto = 0;
  target: () => CamTarget | null = () => null;
  enter() {}
  drag(dx: number, dy: number) { this.az -= dx * 0.005; this.el = clamp(this.el + dy * 0.004, -0.05, 1.45); }
  wheel(dy: number) { this.dist = clamp(this.dist * (dy > 0 ? 1.12 : 0.89), 6, 600); }
  update(ctx: CameraContext, out: Pose) {
    this.az += (this.auto * Math.PI / 180) * ctx.dt;
    const tg = this.target();
    const c = tg ? _v.setFromMatrixPosition(tg.view.vehicleMatrices[0]) : _v.copy(out.pos);
    c.y += 2.2;
    out.pos.set(c.x + Math.cos(this.az) * Math.cos(this.el) * this.dist, c.y + Math.sin(this.el) * this.dist, c.z + Math.sin(this.az) * Math.cos(this.el) * this.dist);
    lookAtQuat(out.pos, c, out.quat);
    out.fov = 50;
  }
}

/** Where an attached camera sits on a vehicle (x forward, y up, z right; m) and what it looks at. */
interface Preset { id: string; name: string; vehicle: 'first' | 'second' | 'last'; at(L: number, bc: number, eye: THREE.Vector3): { pos: number[]; look: number[] }; ground?: boolean }
export const PRESETS: Preset[] = [
  { id: 'front-low', name: 'Front low', vehicle: 'first', at: L => ({ pos: [L / 2 + 7, 0.7, 2.2], look: [L / 2 - 6, 2.0, 0] }), ground: true },
  { id: 'bogie', name: 'Bogie close-up', vehicle: 'first', at: (_L, bc) => ({ pos: [bc / 2 + 0.6, 0.8, 2.5], look: [bc / 2, 0.55, 1.0] }), ground: true },
  { id: 'side-window', name: 'Side window', vehicle: 'second', at: () => ({ pos: [0, 2.55, 1.85], look: [60, 2.0, 1.25] }) },
  { id: 'roof', name: 'Roof', vehicle: 'first', at: L => ({ pos: [-L / 2 + 1.5, 5.3, 0], look: [L / 2 + 60, 4.0, 0] }) },
  { id: 'rear', name: 'Rear', vehicle: 'last', at: L => ({ pos: [-L / 2 - 2.5, 3.0, 0.3], look: [-L / 2 - 80, 1.2, 0] }) },
  { id: 'under-frame', name: 'Under-frame', vehicle: 'second', at: () => ({ pos: [0, 0.42, 0.95], look: [40, 0.4, 0.95] }), ground: true },
  { id: 'cab', name: 'Cab (driver\'s eye)', vehicle: 'first', at: (_L, _b, e) => ({ pos: [e.x, e.y, e.z], look: [e.x + 60, e.y - 1.6, e.z] }) },
  { id: 'high-chase', name: 'High chase', vehicle: 'first', at: L => ({ pos: [-L / 2 - 40, 16, 8], look: [L / 2 + 25, 0, 0] }) },
];

/** A camera fixed to a vehicle of the selected train at a preset, with fine-tune, shake and smooth or locked holding. */
export class AttachCam implements CameraMode {
  readonly name = 'Attached';
  readonly near = 0.05;
  groundClearance = 0.6;
  preset = PRESETS[0];
  tune = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  shakeKind: Shake = 'none';
  smooth = true;
  target: () => CamTarget | null = () => null;
  /** hide the leading loco while looking out of its (empty) cab */
  hideLead: ((on: boolean) => void) | null = null;
  private rot = new THREE.Quaternion();
  private fresh = true;
  enter() { this.fresh = true; }
  exit() { this.hideLead?.(false); }
  setPreset(p: Preset) { this.preset = p; this.fresh = true; this.groundClearance = p.ground ? -Infinity : 0.6; }
  update(ctx: CameraContext, out: Pose) {
    const tg = this.target();
    if (!tg) return;
    const ms = tg.view.vehicleMatrices, n = ms.length;
    const vi = this.preset.vehicle === 'first' ? 0 : this.preset.vehicle === 'last' ? n - 1 : Math.min(1, n - 1);
    const veh = tg.view.vehicles[vi];
    const { pos, look } = this.preset.at(veh.length, veh.bogieCentres, tg.eye);
    this.hideLead?.(this.preset.id === 'cab');
    // the vehicle's frame: position as it is, rotation smoothed (no sway on joints and curves) unless locked
    const m = ms[vi];
    const origin = _v.setFromMatrixPosition(m);
    _q.setFromRotationMatrix(_m.extractRotation(m));
    if (!this.smooth || this.fresh) this.rot.copy(_q); else this.rot.slerp(_q, 1 - Math.exp(-ctx.dt * 4));
    this.fresh = false;
    const local = _v2.set(pos[0] + this.tune.x, pos[1] + this.tune.y, pos[2] + this.tune.z);
    out.pos.copy(local).applyQuaternion(this.rot).add(origin);
    const at = new THREE.Vector3(look[0], look[1], look[2]).applyQuaternion(this.rot).add(origin);
    lookAtQuat(out.pos, at, out.quat);
    out.quat.multiply(_q.setFromEuler(_e.set(this.tune.pitch * Math.PI / 180, this.tune.yaw * Math.PI / 180, 0, 'YXZ')));
    shake(this.shakeKind, ctx.time, tg.speed, out.pos, out.quat);
    out.fov = this.preset.id === 'cab' ? 62 : 50;
  }
}

/** A camera standing at the lineside: looking at the selected train or held where it was placed. */
export class TracksideCam implements CameraMode {
  readonly name = 'Trackside';
  readonly near = 0.2;
  spots: { name: string; pos: THREE.Vector3; quat: THREE.Quaternion }[] = [];
  index = 0;
  follow = true;
  target: () => CamTarget | null = () => null;
  private q = new THREE.Quaternion();
  private fresh = true;
  enter() { this.fresh = true; }
  update(ctx: CameraContext, out: Pose) {
    const s = this.spots[this.index];
    if (!s) return;
    out.pos.copy(s.pos);
    const tg = this.follow ? this.target() : null;
    if (tg) {
      const p = _v.setFromMatrixPosition(tg.view.vehicleMatrices[0]); p.y += 2;
      lookAtQuat(out.pos, p, _q);
      if (this.fresh) this.q.copy(_q); else this.q.slerp(_q, 1 - Math.exp(-ctx.dt * 6));
      out.quat.copy(this.q);
    } else out.quat.copy(s.quat);
    this.fresh = false;
    out.fov = 45;
  }
}

/** A bookmark held (world or train-relative), or a glide from where the camera was to it. */
export interface Bookmark { pos: THREE.Vector3; quat: THREE.Quaternion; fov: number; relative: boolean; train: TrainRef | null; thumb?: string }

export class BookmarkCam implements CameraMode {
  readonly name = 'Bookmark';
  readonly near = 0.1;
  mark: Bookmark | null = null;
  glideS = 0;
  private t = 1;
  private from: Pose = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: 50 };
  resolve: (b: Bookmark, pos: THREE.Vector3, quat: THREE.Quaternion) => boolean = () => false;
  enter(_c: CameraContext, from: Pose) { this.start(from); }
  start(from: Pose) { this.from.pos.copy(from.pos); this.from.quat.copy(from.quat); this.from.fov = from.fov; this.t = this.glideS > 0 ? 0 : 1; }
  update(ctx: CameraContext, out: Pose) {
    if (!this.mark) return;
    const p = new THREE.Vector3(), q = new THREE.Quaternion();
    if (!this.resolve(this.mark, p, q)) { p.copy(this.mark.pos); q.copy(this.mark.quat); }
    this.t = Math.min(1, this.t + (this.glideS > 0 ? ctx.dt / this.glideS : 1));
    const e = this.t * this.t * (3 - 2 * this.t);
    out.pos.copy(this.from.pos).lerp(p, e);
    out.quat.copy(this.from.quat).slerp(q, e);
    out.fov = this.from.fov + (this.mark.fov - this.from.fov) * e;
  }
}

const EXISTING = ["Driver's cab", 'Front', 'Rear', 'Side', 'Chase', 'Cinematic', 'Free'];

/**
 * Record Mode's cameras and the Camera tab: drone, orbit, attached presets,
 * trackside, the Auto Director, bookmarks (Ctrl / Alt + 1..9 save, 1..9 jump,
 * Shift + 1..9 glide), and every existing camera of the game.
 */
export class RecordCameras {
  readonly drone = new DroneCam();
  readonly orbit = new OrbitCam();
  readonly attach = new AttachCam();
  readonly trackside = new TracksideCam();
  readonly bookmark = new BookmarkCam();
  private idx: Record<'drone' | 'orbit' | 'attach' | 'trackside' | 'bookmark', number>;
  readonly marks: (Bookmark | null)[] = Array(9).fill(null);
  glideS = 4;
  relative = false;
  director = { on: false, minS: 5, maxS: 12, which: 'selected' as 'selected' | 'random' | 'player', style: 'calm' as 'calm' | 'energetic', next: 0 };
  /** the train cameras follow (the selected one, or the director's pick) */
  follow: TrainRef = { kind: 'player' };
  readonly el = document.createElement('div');
  private thumbFor = -1;
  private hiddenLead: THREE.Object3D | null = null;
  private filmEl: HTMLElement | null = null;

  constructor(private st: Studio, private trains: RecordTrains) {
    const h = st.h;
    this.idx = {
      drone: h.addCamera(this.drone), orbit: h.addCamera(this.orbit), attach: h.addCamera(this.attach),
      trackside: h.addCamera(this.trackside), bookmark: h.addCamera(this.bookmark),
    };
    // the followed train; else yours; else (studio without a train of yours) the first one spawned
    const target = () => this.trains.camTarget(this.follow) ?? this.trains.camTarget({ kind: 'player' }) ?? (this.trains.list[0] ? this.trains.camTarget({ kind: 'spawned', s: this.trains.list[0] }) : null);
    this.orbit.target = this.attach.target = this.trackside.target = target;
    this.attach.hideLead = on => {
      const tg = on ? target() : null;
      const lead = tg && this.follow.kind !== 'player' ? tg.view.locos[0]?.group ?? null : null;
      if (this.hiddenLead && this.hiddenLead !== lead) { this.hiddenLead.visible = true; this.hiddenLead = null; }
      if (lead) { lead.visible = false; this.hiddenLead = lead; }
    };
    this.bookmark.resolve = (b, pos, quat) => {
      if (!b.relative || !b.train) return false;
      const tg = this.trains.camTarget(b.train);
      if (!tg) return false;
      const m = tg.view.vehicleMatrices[0];
      pos.copy(b.pos).applyMatrix4(m);
      quat.setFromRotationMatrix(_m.extractRotation(m)).multiply(b.quat);
      return true;
    };
    // the camera follows a newly selected train
    this.trains.onFocus = r => { this.follow = r; if (![this.idx.orbit, this.idx.attach, this.idx.trackside].includes(h.cameras.index)) this.use('orbit'); };
    this.el.className = 'rec-cams';
  }

  /** Index of a mode in the camera manager (drone, orbit...). */
  use(mode: keyof RecordCameras['idx'], cut = false) {
    const h = this.st.h;
    h.cameras.select(this.idx[mode], h.cameraContext(0.016), cut);
    this.render();
  }

  private ctx() { return this.st.h.cameraContext(0.016); }

  /** The game's own cameras (cab, chase...) follow the selected train too. */
  existing(i: number) { this.st.h.cameras.select(i, this.ctx()); this.render(); }

  // ------------------------------------------------------------------ bookmarks
  save(slot: number) {
    const c = this.st.h.cameras.camera, tg = this.relative ? this.trains.camTarget(this.follow) : null;
    const b: Bookmark = { pos: c.position.clone(), quat: c.quaternion.clone(), fov: c.fov, relative: !!tg, train: tg ? this.follow : null };
    if (tg) {
      const inv = _m.copy(tg.view.vehicleMatrices[0]).invert();
      b.pos.applyMatrix4(inv);
      b.quat.premultiply(_q.setFromRotationMatrix(new THREE.Matrix4().extractRotation(tg.view.vehicleMatrices[0])).invert());
    }
    this.marks[slot] = b;
    this.thumbFor = slot;
    this.st.toast(`Bookmark ${slot + 1} saved${tg ? ' (moves with the train)' : ''}`);
  }

  jump(slot: number, glide: boolean) {
    const b = this.marks[slot];
    if (!b) { this.st.toast(`No bookmark ${slot + 1} yet (Ctrl or Alt + ${slot + 1} saves one)`, true); return; }
    const h = this.st.h, c = h.cameras.camera;
    this.bookmark.mark = b;
    this.bookmark.glideS = glide ? this.glideS : 0;
    this.director.on = false;
    if (h.cameras.index === this.idx.bookmark) this.bookmark.start({ pos: c.position, quat: c.quaternion, fov: c.fov });
    else h.cameras.select(this.idx.bookmark, this.ctx(), true);
    this.render();
  }

  /** After a frame is drawn: grab a bookmark's thumbnail from the canvas. */
  afterRender() {
    if (this.thumbFor < 0) return;
    const b = this.marks[this.thumbFor], src = this.st.h.canvas;
    this.thumbFor = -1;
    if (!b) return;
    const cv = document.createElement('canvas');
    cv.width = 160; cv.height = 90;
    cv.getContext('2d')!.drawImage(src, 0, 0, 160, 90);
    try { b.thumb = cv.toDataURL('image/jpeg', 0.7); } catch { /* tainted canvas: no thumbnail */ }
    this.render();
  }

  // ------------------------------------------------------------------ trackside and director
  placeTrackside() {
    const c = this.st.h.cameras.camera;
    this.trackside.spots.push({ name: `Trackside ${this.trackside.spots.length + 1}`, pos: c.position.clone(), quat: c.quaternion.clone() });
    this.trackside.index = this.trackside.spots.length - 1;
    this.use('trackside');
  }

  /** Auto Director: cut to a new shot every few seconds. */
  frame(dt: number) {
    const d = this.director;
    if (!d.on) return;
    d.next -= dt;
    if (d.next > 0) return;
    const calm = d.style === 'calm';
    d.next = d.minS + Math.random() * Math.max(0, d.maxS - d.minS) * (calm ? 1 : 0.6);
    // which train
    const all = this.trains.all().filter(r => r.kind !== 'ai' || Math.random() < 0.3);
    if (d.which === 'random' && all.length) this.follow = all[Math.floor(Math.random() * all.length)];
    else if (d.which === 'player') this.follow = { kind: 'player' };
    else this.follow = this.trains.selected ?? { kind: 'player' };
    const shots = calm ? ['high-chase', 'side-window', 'orbit', 'trackside', 'trackside', 'rear', 'cinematic'] : ['front-low', 'bogie', 'under-frame', 'trackside', 'cab', 'roof', 'orbit'];
    const shot = shots[Math.floor(Math.random() * shots.length)];
    const h = this.st.h;
    if (shot === 'orbit') { this.orbit.auto = calm ? 6 : 18; this.orbit.dist = calm ? 70 : 30; this.orbit.el = calm ? 0.45 : 0.15; h.cameras.select(this.idx.orbit, this.ctx(), true); }
    else if (shot === 'cinematic' && this.follow.kind === 'player') h.cameras.select(5, this.ctx(), true);
    else if (shot === 'trackside' || shot === 'cinematic') this.lineside(calm);
    else {
      this.attach.setPreset(PRESETS.find(p => p.id === shot)!);
      this.attach.shakeKind = calm ? 'none' : Math.random() < 0.5 ? 'handheld' : 'light';
      this.attach.smooth = true;
      if (h.cameras.index === this.idx.attach) this.attach.enter(); else h.cameras.select(this.idx.attach, this.ctx(), true);
    }
    this.render();
  }

  /** A lineside camera ahead of the followed train (a "cinematic point"): it watches the train come past. */
  private lineside(calm: boolean) {
    const tg = this.trains.camTarget(this.follow);
    if (!tg) return;
    const r = tg.route, f = newFrame();
    const ahead = (calm ? 0.25 : 0.12) + Math.random() * 0.15 + Math.abs(tg.speed) * 0.004;
    const side = (Math.random() < 0.5 ? -1 : 1) * (calm ? 14 + Math.random() * 20 : 5 + Math.random() * 6);
    r.alignment.sampleOffset(Math.min(r.lengthKm - 0.01, tg.headKm + ahead) * 1000, side, f);
    const g = this.st.h.field.height(f.x, f.z);
    const pos = new THREE.Vector3(f.x, g + (calm ? 3 + Math.random() * 8 : 1.2 + Math.random() * 1.5), f.z);
    this.trackside.spots = this.trackside.spots.filter(s => !s.name.startsWith('Director'));
    this.trackside.spots.push({ name: 'Director', pos, quat: new THREE.Quaternion() });
    this.trackside.index = this.trackside.spots.length - 1;
    this.trackside.follow = true;
    const h = this.st.h;
    if (h.cameras.index === this.idx.trackside) this.trackside.enter(); else h.cameras.select(this.idx.trackside, this.ctx(), true);
  }

  /** Manual camera use stops the director. */
  manual() { if (this.director.on) { this.director.on = false; this.render(); } }

  // ------------------------------------------------------------------ scenes
  toScene(): { bookmarks: SceneFile['bookmarks']; camera: SceneFile['camera'] } {
    const idxOf = (r: TrainRef | null) => !r || r.kind === 'player' ? -1 : r.kind === 'spawned' ? this.trains.list.indexOf(r.s) : -1;
    return {
      bookmarks: this.marks.map(b => b && { pos: b.pos.toArray(), quat: b.quat.toArray(), fov: b.fov, relative: b.relative, train: idxOf(b.train), thumb: b.thumb }),
      camera: {
        droneSpeed: this.drone.speed, droneSmooth: this.drone.smooth, droneLevel: this.drone.level, orbitAuto: this.orbit.auto, orbitDist: this.orbit.dist,
        preset: this.attach.preset.id, shake: this.attach.shakeKind, smooth: this.attach.smooth, glideS: this.glideS, relative: this.relative,
        tuneX: this.attach.tune.x, tuneY: this.attach.tune.y, tuneZ: this.attach.tune.z, tuneYaw: this.attach.tune.yaw, tunePitch: this.attach.tune.pitch,
        dirMin: this.director.minS, dirMax: this.director.maxS, dirStyle: this.director.style, dirWhich: this.director.which,
      },
    };
  }

  fromScene(s: SceneFile) {
    const c = s.camera, num = (k: string, d: number) => (typeof c[k] === 'number' ? (c[k] as number) : d);
    this.drone.speed = num('droneSpeed', 20); this.drone.smooth = num('droneSmooth', 0.5); this.drone.level = c.droneLevel !== false;
    this.orbit.auto = num('orbitAuto', 0); this.orbit.dist = num('orbitDist', 45);
    this.attach.setPreset(PRESETS.find(p => p.id === c.preset) ?? PRESETS[0]);
    this.attach.shakeKind = (['none', 'light', 'handheld'] as Shake[]).includes(c.shake as Shake) ? (c.shake as Shake) : 'none';
    this.attach.smooth = c.smooth !== false;
    this.attach.tune = { x: num('tuneX', 0), y: num('tuneY', 0), z: num('tuneZ', 0), yaw: num('tuneYaw', 0), pitch: num('tunePitch', 0) };
    this.glideS = num('glideS', 4); this.relative = c.relative === true;
    this.director.minS = num('dirMin', 5); this.director.maxS = num('dirMax', 12);
    this.director.style = c.dirStyle === 'energetic' ? 'energetic' : 'calm';
    this.director.which = c.dirWhich === 'random' || c.dirWhich === 'player' ? c.dirWhich : 'selected';
    s.bookmarks.forEach((b, i) => {
      const r: TrainRef | null = !b || b.train < 0 ? (b?.relative ? { kind: 'player' } : null) : this.trains.list[b.train] ? { kind: 'spawned', s: this.trains.list[b.train] } : null;
      this.marks[i] = b && { pos: new THREE.Vector3().fromArray(b.pos), quat: new THREE.Quaternion().fromArray(b.quat), fov: b.fov, relative: b.relative && !!r, train: r, thumb: b.thumb };
    });
    this.render();
  }

  // ------------------------------------------------------------------ the Camera tab
  /** the Film section lives in this tab (FilmLook builds it) */
  setFilm(el: HTMLElement) { this.filmEl = el; this.render(); }

  render() {
    const h = this.st.h, cur = h.cameras.index, a = this.attach, d = this.director;
    const btn = (mode: keyof RecordCameras['idx'], label: string) => `<button data-cm="${mode}" class="${cur === this.idx[mode] ? 'on' : ''}">${label}</button>`;
    const sl = (k: string, label: string, min: number, max: number, step: number, v: number, unit = '') => `<label>${label} <input type="range" min="${min}" max="${max}" step="${step}" value="${v}" data-cs="${k}"><output>${Number(v.toFixed(2))}${unit}</output></label>`;
    const followName = this.trains.alive(this.follow) ? this.trains.info(this.follow).name : this.trains.list[0]?.name ?? 'no train yet';
    this.el.innerHTML = `
      <p class="note">Following <b>${esc(followName)}</b> (select a train in Trains to follow it).</p>
      <div class="rec-modes">${btn('drone', 'Drone')}${btn('orbit', 'Orbit')}${btn('attach', 'Attached')}${btn('trackside', 'Trackside')}
        <button data-cd="toggle" class="${d.on ? 'on' : ''}">Auto Director</button></div>
      <div class="rec-modes small">${EXISTING.map((n, i) => `<button data-ce="${i}" class="${cur === i ? 'on' : ''}">${n}</button>`).join('')}</div>
      <details ${cur === this.idx.drone ? 'open' : ''}><summary>Drone</summary>
        <p class="note">W A S D move, Q / E down / up, drag to look, Shift fast, Ctrl slow, wheel: speed.</p>
        ${sl('droneSpeed', 'Speed', 1, 400, 1, this.drone.speed, ' m/s')}${sl('droneSmooth', 'Smoothness', 0, 1, 0.05, this.drone.smooth)}
        <label class="tog"><input type="checkbox" data-cc="level" ${this.drone.level ? 'checked' : ''}><span>Keep horizon level</span></label></details>
      <details ${cur === this.idx.orbit ? 'open' : ''}><summary>Orbit</summary>
        ${sl('orbitAuto', 'Auto orbit', -40, 40, 1, this.orbit.auto, '&deg;/s')}${sl('orbitDist', 'Distance', 6, 600, 1, this.orbit.dist, ' m')}</details>
      <details ${cur === this.idx.attach ? 'open' : ''}><summary>Attached</summary>
        <div class="rec-modes small">${PRESETS.map(p => `<button data-cp="${p.id}" class="${a.preset === p && cur === this.idx.attach ? 'on' : ''}">${p.name}</button>`).join('')}</div>
        ${sl('tuneX', 'Forward / back', -20, 20, 0.1, a.tune.x, ' m')}${sl('tuneY', 'Up / down', -5, 10, 0.05, a.tune.y, ' m')}${sl('tuneZ', 'Left / right', -10, 10, 0.05, a.tune.z, ' m')}
        ${sl('tuneYaw', 'Turn', -90, 90, 1, a.tune.yaw, '&deg;')}${sl('tunePitch', 'Tilt', -45, 45, 1, a.tune.pitch, '&deg;')}
        <label>Shake <select data-cc="shake">${(['none', 'light', 'handheld'] as Shake[]).map(s => `<option value="${s}" ${s === a.shakeKind ? 'selected' : ''}>${s === 'none' ? 'None' : s === 'light' ? 'Light' : 'Handheld'}</option>`).join('')}</select></label>
        <label>Holding <select data-cc="smooth"><option value="1" ${a.smooth ? 'selected' : ''}>Smooth</option><option value="0" ${a.smooth ? '' : 'selected'}>Locked</option></select></label></details>
      <details ${cur === this.idx.trackside ? 'open' : ''}><summary>Trackside</summary>
        <div class="buttons left"><button data-ct="place">Place here</button></div>
        ${this.trackside.spots.length ? `<label>Camera <select data-cc="spot">${this.trackside.spots.map((s, i) => `<option value="${i}" ${i === this.trackside.index ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>` : '<p class="note">Fly the drone to a spot, then Place here.</p>'}
        <label>Looks at <select data-cc="follow"><option value="1" ${this.trackside.follow ? 'selected' : ''}>The selected train</option><option value="0" ${this.trackside.follow ? '' : 'selected'}>Fixed (as placed)</option></select></label></details>
      <details ${d.on ? 'open' : ''}><summary>Auto Director</summary>
        ${sl('dirMin', 'Shortest shot', 3, 20, 1, d.minS, ' s')}${sl('dirMax', 'Longest shot', 5, 30, 1, d.maxS, ' s')}
        <label>Trains <select data-cc="which"><option value="selected" ${d.which === 'selected' ? 'selected' : ''}>The selected one</option><option value="random" ${d.which === 'random' ? 'selected' : ''}>Any (random)</option><option value="player" ${d.which === 'player' ? 'selected' : ''}>Yours</option></select></label>
        <label>Style <select data-cc="style"><option value="calm" ${d.style === 'calm' ? 'selected' : ''}>Calm</option><option value="energetic" ${d.style === 'energetic' ? 'selected' : ''}>Energetic</option></select></label></details>
      <details open><summary>Bookmarks</summary>
        <p class="note">Ctrl (or Alt) + 1&ndash;9 saves, 1&ndash;9 jumps, Shift + 1&ndash;9 glides.</p>
        <div class="rec-marks">${this.marks.map((b, i) => `<div class="mark ${b ? '' : 'empty'}">${b?.thumb ? `<img src="${b.thumb}" alt="">` : `<span>${i + 1}</span>`}
          <div><button data-cb="save:${i}" title="Save the camera here">Save</button>${b ? `<button data-cb="jump:${i}">Go</button><button data-cb="glide:${i}">Glide</button>` : ''}</div></div>`).join('')}</div>
        ${sl('glideS', 'Glide time', 1, 20, 0.5, this.glideS, ' s')}
        <label>Saved <select data-cc="relative"><option value="0" ${this.relative ? '' : 'selected'}>In the world</option><option value="1" ${this.relative ? 'selected' : ''}>On the followed train</option></select></label></details>
      <div data-k="film"></div>`;
    if (this.filmEl) this.el.querySelector('[data-k="film"]')!.appendChild(this.filmEl);
  }

  bind() {
    this.el.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      const d = b.dataset;
      if (d.cm) { this.manual(); this.use(d.cm as keyof RecordCameras['idx']); }
      if (d.ce) { this.manual(); this.existing(Number(d.ce)); }
      if (d.cp) { this.manual(); this.attach.setPreset(PRESETS.find(p => p.id === d.cp)!); if (this.st.h.cameras.index === this.idx.attach) this.render(); else this.use('attach'); }
      if (d.ct === 'place') { this.manual(); this.placeTrackside(); }
      if (d.cd) { this.director.on = !this.director.on; this.director.next = 0; this.render(); }
      if (d.cb) { const [k, i] = d.cb.split(':'); if (k === 'save') this.save(Number(i)); else this.jump(Number(i), k === 'glide'); }
    });
    this.el.addEventListener('input', e => {
      const t = e.target as HTMLInputElement, k = t.dataset.cs;
      if (!k) return;
      const v = Number(t.value), out = t.nextElementSibling as HTMLOutputElement | null;
      if (out) out.textContent = String(Number(v.toFixed(2))) + (out.textContent?.replace(/^[-\d.]+/, '') ?? '');
      if (k === 'droneSpeed') this.drone.speed = v;
      if (k === 'droneSmooth') this.drone.smooth = v;
      if (k === 'orbitAuto') this.orbit.auto = v;
      if (k === 'orbitDist') this.orbit.dist = v;
      if (k.startsWith('tune')) (this.attach.tune as Record<string, number>)[k.slice(4).replace(/^./, c => c.toLowerCase())] = v;
      if (k === 'dirMin') this.director.minS = v;
      if (k === 'dirMax') this.director.maxS = v;
      if (k === 'glideS') this.glideS = v;
    });
    this.el.addEventListener('change', e => {
      const t = e.target as HTMLInputElement, k = t.dataset.cc;
      if (!k) return;
      if (k === 'level') this.drone.level = t.checked;
      if (k === 'shake') this.attach.shakeKind = t.value as Shake;
      if (k === 'smooth') this.attach.smooth = t.value === '1';
      if (k === 'spot') { this.trackside.index = Number(t.value); this.use('trackside'); }
      if (k === 'follow') this.trackside.follow = t.value === '1';
      if (k === 'which') this.director.which = t.value as 'selected';
      if (k === 'style') this.director.style = t.value as 'calm';
      if (k === 'relative') this.relative = t.value === '1';
    });
  }

  dispose() {
    const h = this.st.h, ctx = this.ctx();
    if (this.hiddenLead) this.hiddenLead.visible = true;
    for (const m of [this.drone, this.orbit, this.attach, this.trackside, this.bookmark]) h.cameras.remove(m, 4, ctx);
  }
}
