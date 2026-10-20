import * as THREE from 'three/webgpu';
import { COACHES, LOCOS } from '../data';
import { TrainView } from '../train/Coach';
import { DieselSmoke } from '../train/Smoke';
import { cabLayout } from '../train/cab/CabModel';
import { effective } from '../core/Settings';
import { Consist, ConsistSpec, LocoData, Vehicle, isFreightStock, withPowerCar } from '@rail/shared/train/Consist';
import { DriveMode, DriveStyle, RecordTrain, PathStop } from '@rail/shared/record/RecordTrain';
import type { PathEnd, ScenePath, SceneTrain } from '@rail/shared/record/SceneFile';
import type { LineControl } from '@rail/shared/signalling/Control';
import { newFrame, RAIL_TOP } from '@rail/shared/track/Chainage';
import type { Route } from '@rail/shared/track/Route';
import type { AITrain } from '@rail/shared/gameplay/AITrain';
import { KMPH } from '@rail/shared/util';
import type { CamTarget, RecordRunner, Studio, TrackHit } from './host';
import { RouteMap } from './RouteMap';
import { icon } from '../ui/theme/icons';

/** Ready-made trains of the spawn picker (Custom opens the consist builder). */
export const READY: { id: string; name: string; sub: string; spec: ConsistSpec }[] = [
  { id: 'express', name: 'Express', sub: '22 coaches', spec: { loco: 'wap7', coaches: [{ type: 'icf', count: 4 }, { type: 'lhb', count: 18 }] } },
  { id: 'local', name: 'Local', sub: '12 coaches', spec: { loco: 'wap7', coaches: [{ type: 'icf', count: 12 }] } },
  { id: 'double-stack', name: 'Double-stack', sub: '60 wagons', spec: { loco: 'wag-12b', coaches: [{ type: 'container-ds', count: 36 }, { type: 'container-ds20', count: 12 }, { type: 'container-single', count: 7 }, { type: 'container-empty', count: 4 }, { type: 'brakevan', count: 1 }] } },
  { id: 'boxcar', name: 'Boxcar goods', sub: '40 wagons', spec: { loco: 'ep-7', coaches: [{ type: 'boxcar', count: 39 }, { type: 'brakevan', count: 1 }] } },
  { id: 'light', name: 'Light engine', sub: 'loco only', spec: { loco: 'wap7', coaches: [] } },
];
/** spawned trains beyond this slow most machines down: warned, not refused */
export const TRAIN_LIMIT = 12;
const COLOURS = ['#3ad1c4', '#f5a623', '#b46cff', '#5ad15f', '#ff6fa8', '#4da3ff', '#ffd23a', '#ff7b3a', '#9be15d', '#e04dff', '#3a8bff', '#c0c0c0'];
const STYLE_NAMES: Record<DriveStyle, string> = { gentle: 'Gentle', normal: 'Normal', aggressive: 'Aggressive' };
const END_NAMES: Record<PathEnd, string> = { stop: 'Stop there', turnback: 'Turn back and repeat', loop: 'Start again (loop)', disappear: 'Disappear' };
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A train placed in Record Mode, with how it looks and sounds. */
export interface Spawned {
  id: string; name: string; colour: string;
  t: RecordTrain; lc: LineControl; view: TrainView; spec: ConsistSpec; loco: LocoData;
  /** drawn backwards (loco at the rear) after turning back */
  reversed: boolean;
  headlight: number; markers: boolean; cabLight: boolean; interior: boolean;
  panto: boolean; pantoPos: number; engine: boolean; smokeAmt: number; smoke: DieselSmoke | null; lastSpeed: number;
  autoHorn: boolean; doors: boolean;
  path: ScenePath | null;
  /** where it was placed (the path starts there): direction view, surveyed km, offset in that view */
  origin: { track: string; km: number; offset: number };
  ribbon: THREE.Mesh | null; ribbonAt: number;
  glow: THREE.Mesh | null;
  hidden: boolean;
  /** positioned at least once (its vehicle matrices are real: cameras can find it) */
  placed: boolean;
}

/** Any train in the list: the player's, a spawned one, or AI traffic. */
export type TrainRef = { kind: 'player' } | { kind: 'spawned'; s: Spawned } | { kind: 'ai'; a: { train: AITrain; view: TrainView; route: Route } };

let nextId = 1;

/**
 * Record Mode's trains: spawning (picker, placement), the train list, the
 * Train Settings card, paths, and running them every step. Stays alive after
 * Record Mode closes when its trains are kept as AI traffic.
 */
export class RecordTrains implements RecordRunner {
  readonly list: Spawned[] = [];
  selected: TrainRef | null = null;
  /** a spawned train driven from the keyboard (arrow keys set its speed) */
  driven: Spawned | null = null;
  /** the panel's element (Trains tab), rebuilt parts on change */
  readonly el = document.createElement('div');
  private map: RouteMap;
  private place = { track: '', line: '', km: 1, station: '', startAs: 'auto' as DriveMode, kmph: 80 };
  private picked: { kind: 'ready' | 'loco' | 'custom'; id: string } = { kind: 'ready', id: 'express' };
  private custom: ConsistSpec = { loco: 'wap7', coaches: [{ type: 'icf', count: 8 }], loaded: true };
  private pathDraft: ScenePath | null = null;
  private mapAcc = 0;
  private listAcc = 0;
  /** studio callbacks (null once Record Mode has closed and the trains run on as traffic) */
  st: Studio | null;
  private ribbonMat = new Map<string, THREE.MeshBasicMaterial>();

  constructor(st: Studio) {
    this.st = st;
    const h = st.h;
    this.map = new RouteMap(h.route);
    this.map.onPick = km => this.mapPick(km);
    this.place.track = h.railway.views[0].running.id;
    this.place.line = this.place.track;
    this.el.className = 'rec-trains';
    this.render();
  }

  private hostRef: Studio['h'] | null = null;
  /** keep the host after Record Mode closes (the trains still need it) */
  detach() { this.hostRef = this.st!.h; this.st = null; this.selected = null; this.driven = null; for (const s of this.list) this.showRibbon(s, false); }
  attach(st: Studio) { this.st = st; this.hostRef = null; this.render(); }
  private get host() { return this.st?.h ?? this.hostRef!; }

  // ------------------------------------------------------------------ spawning
  /** Line choices at a km, in a direction's view: its running line, the other one, the middle line, and the loops of a station there. */
  linesAt(track: string, km: number) {
    const v = this.host.railway.view(track), vk = v.viewKm(km);
    return v.graph.lines.filter(l => vk >= l.fromKm - 1e-6 && vk <= l.toKm + 1e-6).map(l => ({ id: l.id, offset: l.offset }));
  }

  /** Place a train. km surveyed; the offset is in `track`'s view. Null (and a message) when the track there is taken. */
  spawn(spec: ConsistSpec, track: string, km: number, offset: number, opts: Partial<SceneTrain> = {}): Spawned | null {
    const h = this.host, loco = LOCOS[spec.loco];
    if (!loco) return null;
    // (a passenger train with its generator van behind the loco)
    spec = withPowerCar(spec, COACHES);
    const consist = new Consist(loco, COACHES, spec);
    const route = h.railway.view(track), lc = h.ctl.of(route);
    const head = Math.min(route.lengthKm - 0.06, Math.max(consist.length / 1000 + 0.06, route.viewKm(km)));
    // never on top of another train (any direction, the same track)
    const taken = h.ctl.occupantsFor(lc).find(o => o.headKm > head - consist.length / 1000 - 0.04 && o.tailKm < head + 0.04 && Math.abs(o.offsetAt(Math.min(head, Math.max(o.tailKm, head - consist.length / 1000))) - offset) < 1.5);
    if (taken) { this.st?.toast(`That track is taken by ${taken.id === 'player' ? 'your train' : 'another train'} there: pick another place`, true); return null; }
    if (this.list.length >= TRAIN_LIMIT) this.st?.toast(`${this.list.length + 1} trains: more than ${TRAIN_LIMIT} may slow the frame rate down`, true);
    const id = `rec-${nextId++}`;
    const goods = consist.vehicles.some(v => v.kind === 'coach') && consist.vehicles.every(v => v.kind !== 'coach' || isFreightStock(COACHES[v.typeId]));
    const name = opts.name ?? `${loco.name}${spec.coaches.length ? ` + ${consist.vehicles.length - consist.vehicles.filter(v => v.kind === 'loco').length}` : ''} #${nextId - 1}`;
    const t = new RecordTrain(id, name, consist.length, route, lc.block, head, offset, loco.maxSpeedKmph, loco.trainset ? 4 : goods ? 1 : 3);
    const s: Spawned = {
      id, name, colour: COLOURS[(nextId - 2) % COLOURS.length], t, lc, view: null!, spec, loco, reversed: false,
      headlight: opts.headlight ?? 1, markers: opts.markers ?? true, cabLight: opts.cabLight ?? false, interior: opts.interior ?? true,
      panto: opts.panto ?? true, pantoPos: opts.panto === false ? 0 : 1, engine: opts.engine ?? true, smokeAmt: opts.smoke ?? 1, smoke: null, lastSpeed: 0,
      autoHorn: opts.autoHorn ?? true, doors: false, path: null,
      origin: { track, km: route.canonicalKm(head), offset }, ribbon: null, ribbonAt: 0, glow: null, hidden: false, placed: false,
    };
    this.wire(s, t);
    s.view = this.makeView(s, false);
    t.mode = opts.mode ?? 'auto';
    t.kmph = opts.kmph ?? Math.min(loco.maxSpeedKmph, 110);
    t.style = opts.style ?? 'normal';
    t.obeySignals = opts.obeySignals ?? true;
    t.obeyLimits = opts.obeyLimits ?? true;
    if (t.mode === 'speed') t.speed = t.kmph * KMPH;
    if (loco.type === 'diesel') { s.smoke = new DieselSmoke(); h.world.add(s.smoke.group); }
    this.list.push(s);
    if (opts.path) this.setPath(s, opts.path);
    this.render();
    return s;
  }

  /** Register a (new) RecordTrain with signalling: departures wait for its stop to be done; wrong-line running is never routed. */
  private wire(s: Spawned, t: RecordTrain) {
    const h = this.host;
    t.others = () => h.ctl.occupantsFor(s.lc);
    s.lc.add(t);
    s.lc.dispatcher.gates.set(t.id, code => t.doneAt(code));
    if (Math.abs(t.offsetAt(t.headKm) - s.lc.route.running.offset) > 0.5 && h.railway.views.some(v => v !== s.lc.route && Math.abs(-t.offsetAt(t.headKm) - v.running.offset) < 0.5)) s.lc.dispatcher.manual.add(t.id);
    s.t = t;
  }

  private makeView(s: Spawned, reversed: boolean) {
    const c = new Consist(s.loco, COACHES, s.spec);
    let vehicles: Vehicle[] = c.vehicles;
    if (reversed) {
      // running back: the same train end for end (the loco pushes from the rear, facing backwards)
      const L = c.length;
      vehicles = [...c.vehicles].reverse().map(v => ({ ...v, frontOffset: L - v.frontOffset - v.length, reversed: v.kind === 'loco' ? !v.reversed : v.reversed }));
    }
    const goods = s.t.priority === 1;
    const view = new TrainView(vehicles, s.loco, COACHES, goods ? 'freight' : 'passenger', false);
    view.ownMaterials();
    vehicles.forEach((v, i) => { if (v.kind === 'coach' && s.spec.loaded === false) view.setLook(i, false); });
    s.reversed = reversed;
    // cab light: a warm glow behind the leading windscreen (no light source: shaders stay as they are)
    const lead = view.locos[reversed ? view.locos.length - 1 : 0];
    const glow = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.5, 1.6), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.3, 0.8) }));
    const eye = cabLayout(s.loco).eye;
    glow.position.set(eye.x - 0.6, eye.y - 0.3, 0);
    glow.visible = false;
    lead.body.add(glow);
    s.glow = glow;
    const alive = () => this.list.includes(s) && s.view === view;
    this.host.addCompiled(view.group, alive);
    return view;
  }

  remove(s: Spawned) {
    const i = this.list.indexOf(s);
    if (i < 0) return;
    this.list.splice(i, 1);
    s.lc.remove(s.t);
    s.lc.dispatcher.gates.delete(s.t.id);
    s.lc.dispatcher.manual.delete(s.t.id);
    s.t.gone = true;
    this.dropView(s.view);
    s.smoke?.group.removeFromParent();
    this.showRibbon(s, false);
    if (this.driven === s) this.driven = null;
    if (this.selected?.kind === 'spawned' && this.selected.s === s) this.selected = null;
    this.render();
  }

  private dropView(view: TrainView) {
    view.group.removeFromParent();
    for (const lm of view.locos) lm.group.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh && !m.userData.sharedGeometry) m.geometry.dispose(); });
    view.group.traverse(o => { if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose(); });
  }

  /** A train as a scene entry (save, duplicate, undo of a remove). */
  snapshot(s: Spawned): SceneTrain {
    const t = s.t, r = t.route;
    return {
      name: s.name, loco: s.spec.loco, coaches: s.spec.coaches.map(c => ({ ...c })), loaded: s.spec.loaded !== false,
      track: r.running.id, km: r.canonicalKm(t.headKm), offset: t.offsetAt(t.headKm),
      mode: t.mode, kmph: t.kmph, style: t.style, obeySignals: t.obeySignals, obeyLimits: t.obeyLimits,
      headlight: s.headlight, markers: s.markers, cabLight: s.cabLight, interior: s.interior, panto: s.panto, engine: s.engine, smoke: s.smokeAmt,
      autoHorn: s.autoHorn, doors: s.doors, path: s.path ? structuredClone(s.path) : null,
    };
  }

  restore(e: SceneTrain) {
    return this.spawn({ loco: e.loco, coaches: e.coaches, loaded: e.loaded }, e.track, e.km, e.offset, e);
  }

  /** Move a train to a station (World tab teleport): stopped at the platform on its direction's own line, path kept. */
  moveTo(s: Spawned, code: string) {
    const v = this.host.railway.view(s.t.route.running.id), st = v.station(code);
    if (!st) return;
    const snap = this.snapshot(s);
    snap.km = v.canonicalKm(v.stopKm(st, s.t.length));
    snap.offset = v.running.offset;
    snap.mode = 'parked';
    this.remove(s);
    const c = this.restore(snap) ?? this.restore({ ...snap, km: this.snapshot(s).km });
    if (c) this.select({ kind: 'spawned', s: c });
  }

  /** A copy of the train just behind it on the same track (or ahead if behind is taken). */
  duplicate(s: Spawned) {
    const snap = this.snapshot(s), r = s.t.route, len = s.t.length / 1000;
    for (const k of [s.t.tailKm - 0.06, s.t.headKm + len + 0.06]) {
      const c = this.spawn({ loco: snap.loco, coaches: snap.coaches, loaded: snap.loaded }, snap.track, r.canonicalKm(k), s.t.offsetAt(s.t.headKm), { ...snap, name: `${s.name} (copy)` });
      if (c) return c;
    }
    return null;
  }

  // ------------------------------------------------------------------ paths
  /** Give a train a path (or null: none). Stops, markers and slow zones go into its own km. */
  setPath(s: Spawned, p: ScenePath | null) {
    s.path = p ? structuredClone(p) : null;
    this.applyPath(s, false);
    s.ribbonAt = 0;
    this.render();
  }

  private applyPath(s: Spawned, back: boolean) {
    const t = s.t, r = t.route, p = s.path, head = t.headKm, L = t.length;
    t.plan.clear(); t.stops = []; t.slow = []; t.endKm = null; t.held = false; t.delay = 0;
    t.resetStops();
    if (!p) return;
    const vk = (km: number) => r.viewKm(km);
    // going back: to where it started
    let end: number;
    if (back) end = vk(s.origin.km);
    else end = p.dest ? (p.dest.station && r.station(p.dest.station) ? r.stopKm(r.station(p.dest.station)!, L) : vk(p.dest.km)) : r.lengthKm - 0.06;
    if (end <= head + 0.02) { this.st?.toast(`${s.name}: its destination is behind it (trains run forward: pick a point ahead, or use "Turn back")`, true); end = r.lengthKm - 0.06; }
    end = Math.min(end, r.lengthKm - 0.06);
    t.endKm = end;
    const stops: PathStop[] = [];
    for (const st of r.stations) {
      const sk = r.stopKm(st, L);
      if (sk <= head + 0.01 || sk > end + 0.002) continue;
      const isDest = !back && p.dest?.station === st.code;
      if (p.stopAtStations || isDest) {
        stops.push({ km: Math.min(sk, end), seconds: isDest ? 0 : p.stopS, label: st.name, station: st.code });
        t.plan.set(st.code, { station: st.code, line: '', stop: true, dwellS: p.stopS });
      }
    }
    for (const v of p.via) if (v.station && r.station(v.station)) {
      const pl = t.plan.get(v.station);
      t.plan.set(v.station, { station: v.station, line: v.line ?? '', stop: pl?.stop ?? false, dwellS: pl?.dwellS });
    }
    for (const m of p.markers) { const k = vk(m.km); if (k > head && k <= end) stops.push({ km: k, seconds: m.seconds, label: `Stop here ${m.seconds} s` }); }
    t.stops = stops.sort((a, b) => a.km - b.km);
    t.slow = p.slow.map(z => { const a = vk(z.fromKm), b = vk(z.toKm); return { fromKm: Math.min(a, b), toKm: Math.max(a, b), kmph: z.kmph }; });
    t.kmph = p.cruiseKmph;
    t.mode = 'auto';
    t.obeySignals = p.obeySignals; t.obeyLimits = p.obeyLimits;
    if (!back) { t.held = p.start === 'go'; t.delay = p.start === 'after' ? p.afterS : 0; }
  }

  /** "Go all": every train waiting for Go sets off. */
  goAll() { let n = 0; for (const s of this.list) if (s.t.held) { s.t.held = false; n++; } this.st?.toast(n ? `Go: ${n} train${n > 1 ? 's' : ''} set off` : 'No train is waiting for Go'); }

  /** The end of a path was reached: stop, run back, start again or leave. */
  private endOfPath(s: Spawned) {
    const end = s.path?.end ?? 'stop';
    if (end === 'disappear') { this.remove(s); return; }
    if (end === 'loop') { this.restart(s); return; }
    if (end === 'turnback') { this.turnBack(s); return; }
    s.t.mode = 'parked';
  }

  /** Back to where it was placed, same direction, and run the path again. */
  private restart(s: Spawned) {
    const h = this.host, o = s.origin;
    const route = h.railway.view(o.track);
    const t = new RecordTrain(s.id, s.name, s.t.length, route, h.ctl.of(route).block, route.viewKm(o.km), o.offset, s.loco.maxSpeedKmph, s.t.priority);
    this.swap(s, t, h.ctl.of(route), false);
    this.applyPath(s, false);
  }

  /** Run back over the same track to where it started (the other direction's view: wrong-line running, protected by the signals of both). */
  private turnBack(s: Spawned) {
    const h = this.host, from = s.t.route;
    const to = h.railway.views.find(v => v !== from);
    if (!to) { this.st?.toast(`${s.name}: single line, it starts its path again instead`); this.restart(s); return; }
    const goingBack = !s.reversed;
    const head = to.viewKm(from.canonicalKm(s.t.tailKm)), off = -s.t.offsetAt(s.t.tailKm);
    const t = new RecordTrain(s.id, s.name, s.t.length, to, h.ctl.of(to).block, head, off, s.loco.maxSpeedKmph, s.t.priority);
    this.swap(s, t, h.ctl.of(to), goingBack);
    if (goingBack) this.applyPath(s, true);
    else { this.applyPath(s, false); if (s.path) { s.t.held = false; s.t.delay = 0; } }
  }

  /** Replace a train's RecordTrain (new direction or start), keeping its settings. */
  private swap(s: Spawned, t: RecordTrain, lc: LineControl, reversed: boolean) {
    const old = s.t;
    s.lc.remove(old); s.lc.dispatcher.gates.delete(old.id); s.lc.dispatcher.manual.delete(old.id);
    t.style = old.style; t.obeySignals = old.obeySignals; t.obeyLimits = old.obeyLimits; t.kmph = old.kmph; t.mode = old.mode;
    s.lc = lc;
    this.wire(s, t);
    if (reversed !== s.reversed) { const v = s.view; s.view = this.makeView(s, reversed); this.dropView(v); }
    s.ribbonAt = 0;
  }

  // ------------------------------------------------------------------ running
  sim(dt: number) {
    for (const s of [...this.list]) {
      const t = s.t, prev = t.headKm, wasDwell = t.dwell > 0;
      t.update(dt);
      if (t.ended) { this.endOfPath(s); continue; }
      // doors at stops with boarding
      const dwell = t.dwell > 0;
      if (dwell !== wasDwell && s.path?.boarding !== false && t.priority !== 1) s.doors = dwell;
      // whistle boards: the horn, the way drivers do
      if (s.autoHorn && t.headKm > prev) for (const b of t.route.boards) if (b.kind === 'whistle' && b.km > prev && b.km <= t.headKm) this.horn(s, 1.2);
    }
  }

  frame(_dt: number, wdt: number) {
    const h = this.host, night = h.lighting.nightLight, cam = h.cameras.camera.position;
    const far = effective().drawDistance + 300, f = newFrame();
    for (const s of this.list) {
      const t = s.t;
      // far away: not drawn, not updated (level of detail for a dozen long trains)
      t.route.alignment.sample(t.headKm * 1000, f);
      const near = Math.hypot(f.x - cam.x, f.z - cam.z) < far + t.length;
      s.view.group.visible = near && !s.hidden;
      // far away it is still placed once, and kept placed while a camera follows it (cameras read its matrices)
      if (!near && s.placed && !this.followed?.(s)) continue;
      s.placed = true;
      s.view.interior = s.interior ? 1 : 0;
      s.view.update(t.route, t.headKm, km => t.offsetAt(km), t.headKm * 1000, night);
      s.pantoPos += Math.sign((s.panto ? 1 : 0) - s.pantoPos) * Math.min(Math.abs((s.panto ? 1 : 0) - s.pantoPos), wdt / 4);
      const lead = s.reversed ? s.view.locos.length - 1 : 0;
      s.view.locos.forEach((lm, k) => {
        lm.setPantograph(s.loco.type === 'diesel' ? 0 : s.pantoPos);
        const leading = k === lead;
        lm.setLights(leading ? s.headlight : 0, s.markers && (leading || k === s.view.locos.length - 1 - lead), false, 0, 1);
        // the beam in the air as on your own train: at night or in fog only
        lm.setBeam(leading && s.headlight ? Math.min(0.09, night * 0.045 + h.weather.p.fog * 3) * (s.headlight === 2 ? 1 : 0.5) * h.rec.beam : 0);
      });
      if (s.glow) s.glow.visible = s.cabLight;
      this.updateSmoke(s, wdt);
    }
    if (!this.st) return;
    // paths: ribbons in the world (UI only), the map and list now and then
    for (const s of this.list) {
      const show = !!s.path && this.st.uiVisible();
      if (show && (s.ribbonAt -= _dt) <= 0) { s.ribbonAt = 1.5; this.buildRibbon(s); }
      this.showRibbon(s, show);
    }
    this.mapAcc += _dt; this.listAcc += _dt;
    if (this.mapAcc > 0.5 && this.el.isConnected) { this.mapAcc = 0; this.drawMap(); }
    if (this.listAcc > 1 && this.el.isConnected) { this.listAcc = 0; this.refreshList(); }
  }

  private updateSmoke(s: Spawned, wdt: number) {
    if (!s.smoke) return;
    const lm = s.view.locos[s.reversed ? s.view.locos.length - 1 : 0];
    const pos = lm.stack ? this.host.world.worldToLocal(lm.body.localToWorld(lm.stack.clone())) : null;
    const acc = (s.t.speed - s.lastSpeed) / Math.max(wdt, 1e-3);
    if (wdt > 0) s.lastSpeed = s.t.speed;
    const load = Math.min(1, Math.max(0, acc / 0.5)) * (s.t.speed < 25 ? 1 : 0.6);
    const rate = !s.engine || !s.view.group.visible ? 0 : (2.5 + load * 9) * s.smokeAmt;
    const w = this.host.weather.p.wind;
    s.smoke.update(wdt, pos, rate, Math.min(1, 0.1 + load * 0.8), new THREE.Vector3(w * 1.4, 0, w * 0.6));
  }

  /** A horn blast from the train's leading cab. */
  horn(s: Spawned, seconds: number) {
    const p = new THREE.Vector3().setFromMatrixPosition(s.view.vehicleMatrices[s.reversed ? s.view.vehicleMatrices.length - 1 : 0]);
    this.host.trainAudio()?.horn(p.x, p.y + 4, p.z, seconds);
  }

  /** A glowing ribbon along the track the train will take (6 km ahead at most), with posts at its stops. */
  private buildRibbon(s: Spawned) {
    const t = s.t, r = t.route, h = this.host;
    const end = Math.min(t.endKm ?? r.lengthKm, t.headKm + 6);
    if (s.ribbon) { s.ribbon.geometry.dispose(); }
    const off = h.ctl.of(r).block.pathFn(t.headKm, t.offsetAt(t.headKm), end);
    const f = newFrame(), pos: number[] = [], idx: number[] = [];
    let n = 0;
    for (let km = t.headKm; km <= end + 1e-6; km += 0.01) {
      r.alignment.sampleOffset(km * 1000, off(km), f);
      const nx = -Math.sin(f.heading) * 0.22, nz = Math.cos(f.heading) * 0.22, y = f.y + RAIL_TOP + 0.12;
      pos.push(f.x + nx, y, f.z + nz, f.x - nx, y, f.z - nz);
      if (n) idx.push(2 * n - 2, 2 * n - 1, 2 * n, 2 * n - 1, 2 * n + 1, 2 * n);
      n++;
    }
    // posts at stops and slow zones
    const post = (km: number, hgt: number) => {
      if (km < t.headKm || km > end) return;
      r.alignment.sampleOffset(km * 1000, off(km), f);
      const b = n * 2, y = f.y + RAIL_TOP, nx = -Math.sin(f.heading) * 0.2, nz = Math.cos(f.heading) * 0.2;
      pos.push(f.x + nx, y, f.z + nz, f.x - nx, y, f.z - nz, f.x + nx, y + hgt, f.z + nz, f.x - nx, y + hgt, f.z - nz);
      idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
      n += 2;
    };
    for (const p of t.stops) post(p.km, 4);
    for (const z of t.slow) { post(z.fromKm, 2.5); post(z.toKm, 2.5); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    if (!s.ribbon) {
      let m = this.ribbonMat.get(s.colour);
      if (!m) {
        const c = new THREE.Color(s.colour).multiplyScalar(2.2);
        m = new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false });
        this.ribbonMat.set(s.colour, m);
      }
      s.ribbon = new THREE.Mesh(g, m);
      s.ribbon.frustumCulled = false;
      s.ribbon.renderOrder = 6;
    } else s.ribbon.geometry = g;
  }

  private showRibbon(s: Spawned, on: boolean) {
    if (!s.ribbon) return;
    if (on && !s.ribbon.parent) this.host.world.add(s.ribbon);
    if (!on && s.ribbon.parent) s.ribbon.removeFromParent();
  }

  // ------------------------------------------------------------------ selection and cameras
  /** Every train: yours, the spawned ones, AI traffic. */
  all(): TrainRef[] {
    const you: TrainRef[] = this.host.player.hidden() ? [] : [{ kind: 'player' }];
    return [...you, ...this.list.map(s => ({ kind: 'spawned' as const, s })), ...this.host.ai().map(a => ({ kind: 'ai' as const, a }))];
  }

  info(r: TrainRef) {
    const h = this.host;
    if (r.kind === 'player') return { name: 'Your train', view: h.player.view, route: h.player.route(), headKm: h.player.headKm(), speed: h.player.speed(), length: h.player.consist.length, loco: h.player.consist.loco, colour: '#ff4d3a', reversed: false };
    if (r.kind === 'spawned') return { name: r.s.name, view: r.s.view, route: r.s.t.route, headKm: r.s.t.headKm, speed: r.s.t.speed, length: r.s.t.length, loco: r.s.loco, colour: r.s.colour, reversed: r.s.reversed };
    return { name: r.a.train.name ?? r.a.train.id, view: r.a.view, route: r.a.route, headKm: r.a.train.headKm, speed: r.a.train.speed, length: r.a.train.length, loco: LOCOS[r.a.view.loco.data.id] ?? r.a.view.loco.data, colour: '#4da3ff', reversed: false };
  }

  /** still in the world */
  alive(r: TrainRef) {
    return r.kind === 'player' ? !this.host.player.hidden() : (r.kind === 'spawned' ? this.list.includes(r.s) : !r.a.train.gone && this.host.ai().some(a => a.train === r.a.train));
  }

  /** What cameras follow for a train: the leading vehicle's view, its km and the driver's eye. */
  camTarget(r: TrainRef): CamTarget | null {
    if (!this.alive(r)) return null;
    const i = this.info(r), m = i.loco.model?.cab;
    return { view: i.view, route: i.route, headKm: i.headKm, speed: i.speed, eye: m && r.kind === 'player' ? new THREE.Vector3(...m.eye) : cabLayout(i.loco).eye.clone() };
  }

  same(a: TrainRef | null, b: TrainRef | null) {
    if (!a || !b || a.kind !== b.kind) return false;
    return a.kind === 'player' || (a.kind === 'spawned' ? a.s === (b as typeof a).s : a.a.train === (b as typeof a).a.train);
  }

  /** The train nearest to a ray (world space), within a few metres of it. */
  trainAt(origin: THREE.Vector3, dir: THREE.Vector3): TrainRef | null {
    let best: TrainRef | null = null, bd = 4;
    const p = new THREE.Vector3(), v = new THREE.Vector3();
    for (const r of this.all()) {
      const view = this.info(r).view;
      if (!view.group.visible) continue;
      for (const m of view.vehicleMatrices) {
        p.setFromMatrixPosition(m); p.y += 2;
        const along = v.subVectors(p, origin).dot(dir);
        if (along < 0) continue;
        const d = v.subVectors(p, origin).addScaledVector(dir, -along).length() - 1.6;
        if (d < bd) { bd = d; best = r; }
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ the Trains tab
  private mapPick(km: number) {
    if (this.st?.mapClick(km)) return; // a pick in progress takes map clicks itself
    this.place.km = km;
    this.place.station = '';
    this.render();
  }

  /** The spawn picker: every loco and the trainset, the ready trains, Custom. */
  private pickerHtml() {
    const card = (kind: string, id: string, name: string, sub: string, loco: LocoData | undefined) => `
      <button class="rec-pick ${this.picked.kind === kind && this.picked.id === id ? 'on' : ''}" data-pick="${kind}:${id}" style="--liv:${loco?.livery.body ?? '#3a4450'}">
        ${loco ? `<img src="assets/thumbs/${loco.id}.jpg" alt="" loading="lazy" onerror="this.remove()">` : ''}<b>${esc(name)}</b><small>${esc(sub)}</small></button>`;
    return `<div class="rec-picker">
      ${Object.values(LOCOS).map(l => card('loco', l.id, l.name, l.trainset ? `trainset, ${l.trainset.cars.length} cars` : 'light engine', l)).join('')}
      ${READY.map(r => card('ready', r.id, r.name, r.sub, LOCOS[r.spec.loco])).join('')}
      ${card('custom', 'custom', 'Custom', 'consist builder', LOCOS[this.custom.loco])}
    </div>
    ${this.picked.kind === 'custom' ? this.builderHtml() : ''}`;
  }

  private builderHtml() {
    const c = this.custom;
    const n = (id: string) => c.coaches.find(x => x.type === id)?.count ?? 0;
    return `<div class="rec-builder"><label>Loco <select data-c="loco">${Object.values(LOCOS).map(l => `<option value="${l.id}" ${l.id === c.loco ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
      ${LOCOS[c.loco]?.trainset ? '<p class="note">A trainset runs alone.</p>' : Object.values(COACHES).map(t => `<label>${esc(t.name)} <input type="number" min="0" max="80" value="${n(t.id)}" data-cc="${t.id}"></label>`).join('')}
      <label class="tog"><input type="checkbox" data-c="loaded" ${c.loaded !== false ? 'checked' : ''}><span>Loaded</span></label></div>`;
  }

  private spec(): ConsistSpec {
    const p = this.picked;
    if (p.kind === 'loco') return { loco: p.id, coaches: [] };
    if (p.kind === 'custom') return structuredClone(this.custom);
    return structuredClone(READY.find(r => r.id === p.id)!.spec);
  }

  private placeHtml() {
    const h = this.host, p = this.place, route = h.route;
    const tracks = h.railway.views.map(v => v.running.id);
    const lines = this.linesAt(p.track, p.km);
    const lineName = (id: string) => id === p.track ? `${id} (its own line)` : tracks.includes(id) ? `${id} line (wrong line)` : id === 'ML' ? 'Middle line' : `Loop ${id}`;
    return `<div class="rec-place">
      <div class="row"><label>Station <select data-p="station"><option value="">km ${p.km.toFixed(2)}</option>${route.stations.map(s => `<option value="${s.code}" ${s.code === p.station ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
      <label>km <input type="number" step="0.1" min="0.2" max="${(route.lengthKm - 0.2).toFixed(1)}" value="${p.km.toFixed(2)}" data-p="km"></label></div>
      <div class="row">${tracks.length > 1 ? `<label>Direction <select data-p="track">${tracks.map(t => `<option value="${t}" ${t === p.track ? 'selected' : ''}>${t === 'DOWN' ? 'Down (km rising)' : t === 'UP' ? 'Up (km falling)' : t}</option>`).join('')}</select></label>` : ''}
      <label>Line <select data-p="line">${lines.map(l => `<option value="${l.id}" ${l.id === p.line ? 'selected' : ''}>${esc(lineName(l.id))}</option>`).join('')}</select></label></div>
      <div class="row"><label>Start as <select data-p="startAs"><option value="parked" ${p.startAs === 'parked' ? 'selected' : ''}>Parked</option><option value="auto" ${p.startAs === 'auto' ? 'selected' : ''}>Auto drive</option><option value="speed" ${p.startAs === 'speed' ? 'selected' : ''}>Moving at a set speed</option></select></label>
      <label>Speed <input type="number" min="0" max="400" step="5" value="${p.kmph}" data-p="kmph"> km/h</label></div>
      <div class="buttons left"><button data-a="spawn" class="primary">Place here</button><button data-a="place-click" title="Then click the track in the world (or the map)">Place on track&hellip;</button></div>
    </div>`;
  }

  private spawnFromForm(hit?: TrackHit) {
    const h = this.host, p = this.place;
    let km = p.km, line = p.line, track = p.track;
    if (p.station && !hit) { const st = h.route.station(p.station); if (st) km = st.km + (h.railway.view(track).mirrored ? -1 : 1) * 0.1; }
    if (hit) {
      km = hit.km;
      if (hit.line) {
        line = hit.line;
        // a running line runs its own way; loops and the middle line the chosen direction
        if (h.railway.views.some(v => v.running.id === hit.line)) track = hit.line;
      }
    }
    const v = h.railway.view(track);
    const spec = this.spec();
    const len = new Consist(LOCOS[spec.loco], COACHES, withPowerCar(spec, COACHES)).length / 1000;
    // a train placed at a station stands with its head at the far end of the platform, otherwise the head is where you clicked
    const st = !hit && p.station ? v.station(p.station) : undefined;
    const headView = st ? v.stopKm(st, len * 1000) : v.viewKm(km);
    const lines = this.linesAt(track, v.canonicalKm(headView));
    const l = lines.find(x => x.id === line) ?? lines.find(x => x.id === track) ?? lines[0];
    if (!l) { this.st?.toast('No track there', true); return; }
    // the whole train must be on that line (loops are short)
    const lineDef = v.graph.lines.find(x => x.id === l.id)!;
    if (headView - len < lineDef.fromKm - 1e-6 || headView > lineDef.toKm + 1e-6) { this.st?.toast(`The train (${Math.round(len * 1000)} m) does not fit on that line there`, true); return; }
    const s = this.spawn(spec, track, v.canonicalKm(headView), l.offset, { mode: p.startAs, kmph: p.kmph });
    if (!s) return;
    this.select({ kind: 'spawned', s });
    this.st?.pushUndo(`place ${s.name}`, () => this.remove(s));
    this.st?.toast(`${s.name} placed at km ${v.canonicalKm(headView).toFixed(2)}`);
  }

  select(r: TrainRef | null) { this.selected = r; this.render(); }

  /** The spawn form set to a station (the one chosen when the studio opened). */
  placeAt(code: string) {
    const st = this.host.route.station(code);
    if (st) { this.place.station = code; this.place.km = st.km; this.render(); }
  }

  /** The list of all trains with Select / Focus / Drive / Duplicate / Remove. */
  private listHtml() {
    const rows = this.all().map((r, i) => {
      const n = this.info(r), sel = this.same(r, this.selected);
      const kind = r.kind === 'player' ? 'yours' : r.kind === 'spawned' ? (r.s.t.held ? 'waiting for Go' : r.s.t.dwell > 0 ? 'at a stop' : r.s.t.mode) : 'AI traffic';
      return `<tr class="${sel ? 'sel' : ''}" data-i="${i}"><td><span class="dot" style="background:${n.colour}"></span>${esc(n.name)}</td><td>${Math.round(Math.abs(n.speed) * 3.6)}</td><td>${n.route.canonicalKm(n.headKm).toFixed(1)}</td><td class="dim">${kind}</td>
        <td class="acts"><button data-t="select" title="Select (settings card)" aria-label="Select">${icon('select')}</button><button data-t="focus" title="Focus camera" aria-label="Focus camera">${icon('videoCamera')}</button><button data-t="drive" title="Drive this train" aria-label="Drive">${icon('train')}</button>${r.kind !== 'player' ? `<button data-t="dup" title="Duplicate" aria-label="Duplicate">${icon('copy')}</button><button data-t="remove" title="Remove (Ctrl+Z brings it back)" aria-label="Remove">${icon('trash')}</button>` : ''}</td></tr>`;
    });
    return `<table class="rec-list"><tr><th>Train</th><th>km/h</th><th>km</th><th></th><th></th></tr>${rows.join('')}</table>`;
  }

  private refreshList() {
    const el = this.el.querySelector('[data-k="list"]');
    if (el) el.innerHTML = this.listHtml();
  }

  /** The Train Settings card for the selected train. */
  private cardHtml() {
    const r = this.selected;
    if (!r || !this.alive(r)) return '';
    if (r.kind === 'ai') return `<div class="rec-card"><h4>${esc(this.info(r).name)}</h4><p class="note">AI traffic: it runs to its own timetable. <b>Drive this train</b> takes it over as a Record Mode train (then everything here can be set).</p></div>`;
    const h = this.host;
    if (r.kind === 'player') {
      const pd = h.rec.playerDrive, s = h.player.sys;
      return `<div class="rec-card"><h4>Your train</h4>
        <label class="tog"><input type="checkbox" data-s="pdrive" ${pd ? 'checked' : ''}><span>Driven by Record Mode</span><small>off: as you left it (keys only with Drive this train)</small></label>
        ${pd ? this.speedHtml(pd.kmph, h.player.consist.loco.maxSpeedKmph, pd.style, true, pd.obeySignals, pd.obeyLimits) : ''}
        <h5>Lights</h5>${this.lightsHtml(s.headlight, s.markers, s.cabLight, true)}
        <h5>Horn</h5><div class="buttons left"><button data-s="horn-short">Short</button><button data-s="horn-long">Long</button></div>
        ${s.isDiesel ? `<label class="tog"><input type="checkbox" data-s="engine" ${s.engine !== 'stopped' ? 'checked' : ''}><span>Engine running</span></label>` : `<label class="tog"><input type="checkbox" data-s="panto" ${s.pantoUp ? 'checked' : ''}><span>Pantograph up</span></label>`}
        <div class="buttons left"><button data-s="doors">Doors open / close</button></div></div>`;
    }
    const s = r.s, t = s.t, freight = t.priority === 1;
    return `<div class="rec-card" style="--c:${s.colour}"><h4><input value="${esc(s.name)}" data-s="name" maxlength="40"></h4>
      ${this.speedHtml(t.kmph, s.loco.maxSpeedKmph, t.style, t.mode === 'auto', t.obeySignals, t.obeyLimits)}
      <h5>Lights</h5>${this.lightsHtml(s.headlight, s.markers, s.cabLight, false, s.interior, freight)}
      <h5>Horn</h5><div class="buttons left"><button data-s="horn-short">Short</button><button data-s="horn-long">Long</button></div>
      <label class="tog"><input type="checkbox" data-s="autoHorn" ${s.autoHorn ? 'checked' : ''}><span>Horn at whistle boards</span></label>
      ${s.loco.type === 'diesel' ? `<label class="tog"><input type="checkbox" data-s="engine" ${s.engine ? 'checked' : ''}><span>Engine running</span></label>
        <label>Smoke <input type="range" min="0" max="2" step="0.1" value="${s.smokeAmt}" data-s="smoke"><output>${s.smokeAmt.toFixed(1)}&times;</output></label>`
      : `<label class="tog"><input type="checkbox" data-s="panto" ${s.panto ? 'checked' : ''}><span>Pantograph up</span></label>`}
      ${freight ? `<label class="tog"><input type="checkbox" data-s="loaded" ${s.spec.loaded !== false ? 'checked' : ''}><span>Loaded wagons</span></label>` : `<div class="buttons left"><button data-s="doors">${s.doors ? 'Close doors' : 'Open doors'}</button></div>`}
      <h5>Path</h5>${this.pathSummary(s)}
      <div class="buttons left"><button data-s="path">${s.path ? 'Edit path' : 'Set path'}</button>${s.path ? '<button data-s="clear-path">Clear path</button>' : ''}${t.held ? '<button data-s="go" class="primary">Go</button>' : ''}</div>
      ${this.pathDraft && this.selectedSpawned() === s ? this.pathEditorHtml(s) : ''}
    </div>`;
  }

  private speedHtml(kmph: number, max: number, style: DriveStyle, auto: boolean, sig: boolean, lim: boolean) {
    return `<label>Speed <input type="range" min="0" max="${max}" step="5" value="${Math.min(max, kmph)}" data-s="kmph"><output>${Math.round(kmph)} km/h</output></label>
      <div class="buttons left"><button data-s="speed-now" title="Jump to this speed at once">Set speed now</button><button data-s="speed-gradual">Reach gradually</button></div>
      <label>Driving style <select data-s="style">${(Object.keys(STYLE_NAMES) as DriveStyle[]).map(k => `<option value="${k}" ${k === style ? 'selected' : ''}>${STYLE_NAMES[k]}</option>`).join('')}</select></label>
      <label class="tog"><input type="checkbox" data-s="auto" ${auto ? 'checked' : ''}><span>Auto drive</span><small>runs its path, stops where it should</small></label>
      <label class="tog"><input type="checkbox" data-s="obeySignals" ${sig ? 'checked' : ''}><span>Obey signals</span></label>
      <label class="tog"><input type="checkbox" data-s="obeyLimits" ${lim ? 'checked' : ''}><span>Obey speed limits</span></label>`;
  }

  private lightsHtml(head: number, markers: boolean, cab: boolean, player: boolean, interior = true, freight = false) {
    return `<label>Headlight <select data-s="headlight">${['Off', 'Dim', 'Bright'].map((n, i) => `<option value="${i}" ${i === head ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label class="tog"><input type="checkbox" data-s="markers" ${markers ? 'checked' : ''}><span>Marker lights</span></label>
      <label class="tog"><input type="checkbox" data-s="cabLight" ${cab ? 'checked' : ''}><span>Cab light</span></label>
      ${player || freight ? '' : `<label class="tog"><input type="checkbox" data-s="interior" ${interior ? 'checked' : ''}><span>Coach interior lights</span></label>`}`;
  }

  private pathSummary(s: Spawned) {
    const p = s.path;
    if (!p) return '<p class="note">No path: it runs on along its line.</p>';
    const r = s.t.route, dest = p.dest?.station ? r.station(p.dest.station)?.name : p.dest ? `km ${p.dest.km.toFixed(2)}` : 'the end of the line';
    return `<p class="note">To <b>${esc(dest ?? '?')}</b> at ${p.cruiseKmph} km/h${p.stopAtStations ? `, stopping ${p.stopS} s at stations` : ''}${p.markers.length ? `, ${p.markers.length} stop marker${p.markers.length > 1 ? 's' : ''}` : ''}${p.slow.length ? `, ${p.slow.length} slow zone${p.slow.length > 1 ? 's' : ''}` : ''}. Then: ${END_NAMES[p.end].toLowerCase()}.${s.t.held ? ' <b>Waiting for Go.</b>' : s.t.delay > 0 ? ` Starts in ${Math.ceil(s.t.delay)} s.` : ''}</p>`;
  }

  private newPath(s: Spawned): ScenePath {
    return { dest: null, via: [], stopAtStations: false, stopS: 30, boarding: true, markers: [], slow: [], cruiseKmph: Math.min(s.loco.maxSpeedKmph, 110), obeySignals: true, obeyLimits: true, end: 'stop', start: 'now', afterS: 10 };
  }

  private pathEditorHtml(s: Spawned) {
    const p = this.pathDraft!, r = s.t.route, h = this.host;
    const ahead = r.stations.filter(st => r.stopKm(st, s.t.length) > s.t.headKm + 0.02);
    const name = (km: number) => `km ${km.toFixed(2)}`;
    const viaLines = (code: string) => (r.station(code)?.lineInfo ?? []).map(l => l.id);
    return `<div class="rec-path">
      <label>Destination <select data-q="dest"><option value="">${p.dest && !p.dest.station ? name(p.dest.km) : 'End of the line'}</option>${ahead.map(st => `<option value="${st.code}" ${p.dest?.station === st.code ? 'selected' : ''}>${esc(st.name)}</option>`).join('')}</select></label>
      <div class="buttons left"><button data-q="pick-dest">Pick destination on the track&hellip;</button></div>
      <h5>Via</h5>${p.via.map((v, i) => `<div class="row">${esc(v.station ? r.station(v.station)?.name ?? v.station : name(v.km))}
        ${v.station ? `<select data-qv="${i}">${viaLines(v.station).map(l => `<option value="${l}" ${l === v.line ? 'selected' : ''}>${l === r.running.id ? 'Main line' : l === 'ML' ? 'Middle line' : `Loop ${l}`}</option>`).join('')}</select>` : ''}
        <button data-qx="via:${i}" title="Remove" aria-label="Remove">${icon('close')}</button></div>`).join('')}
      <div class="row"><select data-q="via-station"><option value="">Add a station&hellip;</option>${ahead.filter(st => st.lineInfo.length > 1).map(st => `<option value="${st.code}">${esc(st.name)}</option>`).join('')}</select><button data-q="pick-via">Pick on track&hellip;</button></div>
      <label>Cruise speed <input type="number" min="5" max="${s.loco.maxSpeedKmph}" step="5" value="${p.cruiseKmph}" data-q="cruiseKmph"> km/h</label>
      <label class="tog"><input type="checkbox" data-q="obeySignals" ${p.obeySignals ? 'checked' : ''}><span>Obey signals</span></label>
      <label class="tog"><input type="checkbox" data-q="obeyLimits" ${p.obeyLimits ? 'checked' : ''}><span>Obey speed limits</span></label>
      <label class="tog"><input type="checkbox" data-q="stopAtStations" ${p.stopAtStations ? 'checked' : ''}><span>Stop at stations</span></label>
      ${p.stopAtStations ? `<label>Stop time <input type="number" min="0" max="600" step="5" value="${p.stopS}" data-q="stopS"> s</label>
      <label class="tog"><input type="checkbox" data-q="boarding" ${p.boarding ? 'checked' : ''}><span>Doors open (boarding)</span></label>` : ''}
      <h5>Stop markers</h5>${p.markers.map((m, i) => `<div class="row">${name(m.km)}: stop <input type="number" min="0" max="3600" step="5" value="${m.seconds}" data-qm="${i}"> s <button data-qx="marker:${i}" aria-label="Remove">${icon('close')}</button></div>`).join('')}
      <div class="buttons left"><button data-q="pick-marker">Add "Stop here"&hellip;</button></div>
      <h5>Slow zones</h5>${p.slow.map((z, i) => `<div class="row">${name(z.fromKm)} &ndash; ${name(z.toKm)}: <input type="number" min="5" max="300" step="5" value="${z.kmph}" data-qz="${i}"> km/h <button data-qx="slow:${i}" aria-label="Remove">${icon('close')}</button></div>`).join('')}
      <div class="buttons left"><button data-q="pick-slow">Add "Slow to"&hellip;</button></div>
      <label>When finished <select data-q="end">${(Object.keys(END_NAMES) as PathEnd[]).map(k => `<option value="${k}" ${k === p.end ? 'selected' : ''}>${END_NAMES[k]}</option>`).join('')}</select></label>
      <label>Start <select data-q="start"><option value="now" ${p.start === 'now' ? 'selected' : ''}>Now</option><option value="go" ${p.start === 'go' ? 'selected' : ''}>On "Go"</option><option value="after" ${p.start === 'after' ? 'selected' : ''}>After a delay</option></select></label>
      ${p.start === 'after' ? `<label>Delay <input type="number" min="0" max="3600" step="1" value="${p.afterS}" data-q="afterS"> s</label>` : ''}
      <div class="buttons left"><button data-q="apply" class="primary">Use this path</button><button data-q="cancel">Cancel</button></div>
      ${h.railway.views.length < 2 && p.end === 'turnback' ? '<p class="note">Single line: "turn back" starts the path again.</p>' : ''}
    </div>`;
  }

  private selectedSpawned() { return this.selected?.kind === 'spawned' ? this.selected.s : null; }

  drawMap() {
    if (!this.st) return;
    const h = this.host, cam = h.cameras.camera.position;
    const dots = this.all().map(r => { const n = this.info(r); return { km: n.route.canonicalKm(n.headKm), colour: n.colour, r: r.kind === 'ai' ? 3 : 4.5, ring: this.same(r, this.selected) }; });
    dots.push({ km: this.place.km, colour: 'rgba(255,255,255,0.35)', r: 3, ring: false });
    const paths = this.list.filter(s => s.path && s.t.endKm !== null).map(s => ({
      fromKm: s.t.route.canonicalKm(s.t.headKm), toKm: s.t.route.canonicalKm(s.t.endKm!), colour: s.colour, stops: s.t.stops.map(p => s.t.route.canonicalKm(p.km)),
    }));
    this.map.draw(dots, paths, { x: cam.x, z: cam.z }, false);
  }

  /** Rebuild the tab (on changes; the list and map refresh by themselves). */
  render() {
    if (!this.st) return;
    const open = this.el.querySelector<HTMLDetailsElement>('details.rec-spawn')?.open ?? true;
    this.el.innerHTML = `
      <details class="rec-spawn" ${open ? 'open' : ''}><summary>Spawn a train</summary>${this.pickerHtml()}${this.placeHtml()}</details>
      <div class="rec-mapwrap"></div>
      <div class="buttons left"><button data-a="go-all" title="Every train waiting for Go sets off">Go all</button><span class="note">${this.list.length} spawned${this.list.length > TRAIN_LIMIT ? ` (over ${TRAIN_LIMIT}: frame rate may drop)` : ''}</span></div>
      <div data-k="list">${this.listHtml()}</div>
      <div data-k="card">${this.cardHtml()}</div>`;
    this.el.querySelector('.rec-mapwrap')!.appendChild(this.map.canvas);
    this.drawMap();
  }

  /** Clicks, changes and inputs on the tab (bound once by the menu). */
  bind() {
    const el = this.el;
    el.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) {
        const row = (e.target as HTMLElement).closest('tr[data-i]') as HTMLElement | null;
        if (row) this.select(this.all()[Number(row.dataset.i)] ?? null);
        return;
      }
      const d = b.dataset;
      if (d.pick) { const [kind, id] = d.pick.split(':'); this.picked = { kind: kind as 'ready', id }; if (kind === 'loco' || kind === 'custom') this.custom.loco = kind === 'loco' ? id : this.custom.loco; this.render(); return; }
      if (d.a === 'spawn') this.spawnFromForm();
      if (d.a === 'place-click') this.st?.pick('Click the track where the train\'s head should be', hit => this.spawnFromForm(hit));
      if (d.a === 'go-all') this.goAll();
      if (d.t) {
        const row = b.closest('tr[data-i]') as HTMLElement;
        const r = this.all()[Number(row.dataset.i)];
        if (r) this.listAction(d.t, r);
      }
      if (d.s) this.cardAction(d.s);
      if (d.q) this.pathAction(d.q);
      if (d.qx) {
        const [k, i] = d.qx.split(':'), p = this.pathDraft!;
        (k === 'via' ? p.via : k === 'marker' ? p.markers : p.slow).splice(Number(i), 1);
        this.render();
      }
    });
    el.addEventListener('change', e => this.onInput(e.target as HTMLInputElement, true));
    el.addEventListener('input', e => this.onInput(e.target as HTMLInputElement, false));
  }

  private onInput(t: HTMLInputElement, committed: boolean) {
    const d = t.dataset, val = t.type === 'checkbox' ? t.checked : t.value;
    if (d.p) {
      const p = this.place as Record<string, unknown>;
      if (d.p === 'km') { p.km = Number(val) || 0; p.station = ''; }
      else if (d.p === 'kmph') p.kmph = Number(val) || 0;
      else p[d.p] = val;
      if (d.p === 'station' && val) { p.km = this.host.route.station(String(val))?.km ?? p.km; if (committed) this.onStation?.(String(val)); }
      if (d.p === 'track') p.line = String(val);
      if (committed && d.p !== 'kmph') this.render();
      return;
    }
    if (d.c || d.cc) {
      const c = this.custom;
      if (d.c === 'loco') c.loco = String(val);
      else if (d.c === 'loaded') c.loaded = !!val;
      else if (d.cc) { const n = Math.max(0, Math.min(80, Number(val) || 0)); const g = c.coaches.find(x => x.type === d.cc); if (g) g.count = n; else c.coaches.push({ type: d.cc, count: n }); c.coaches = c.coaches.filter(x => x.count > 0); }
      if (committed && d.c === 'loco') this.render();
      return;
    }
    if (d.s) {
      const out = t.nextElementSibling as HTMLOutputElement | null;
      if (d.s === 'kmph' && out) out.textContent = `${t.value} km/h`;
      if (d.s === 'smoke' && out) out.textContent = `${Number(t.value).toFixed(1)}×`;
      if (committed || t.type === 'checkbox' || t.tagName === 'SELECT') this.cardInput(d.s, val);
      return;
    }
    const p = this.pathDraft;
    if (!p) return;
    if (d.q) {
      if (d.q === 'dest') { p.dest = val ? { km: this.host.route.station(String(val))?.km ?? 0, station: String(val) } : null; }
      else if (d.q === 'via-station' && val) { p.via.push({ km: this.host.route.station(String(val))!.km, station: String(val), line: this.selectedSpawned()?.t.route.station(String(val))?.lineInfo[1]?.id }); }
      else if (['cruiseKmph', 'stopS', 'afterS'].includes(d.q)) (p as unknown as Record<string, number>)[d.q] = Number(val) || 0;
      else if (['obeySignals', 'obeyLimits', 'stopAtStations', 'boarding'].includes(d.q)) (p as unknown as Record<string, boolean>)[d.q] = !!val;
      else if (d.q === 'end') p.end = val as PathEnd;
      else if (d.q === 'start') p.start = val as ScenePath['start'];
      if (committed && ['dest', 'via-station', 'stopAtStations', 'start'].includes(d.q)) this.render();
    }
    if (d.qv) p.via[Number(d.qv)].line = String(val);
    if (d.qm) p.markers[Number(d.qm)].seconds = Number(val) || 0;
    if (d.qz) p.slow[Number(d.qz)].kmph = Number(val) || 5;
  }

  private listAction(a: string, r: TrainRef) {
    const st = this.st!;
    if (a === 'select') this.select(r);
    if (a === 'focus') { this.select(r); this.onFocus?.(r); }
    if (a === 'drive') this.drive(r);
    if (a === 'dup' && r.kind === 'spawned') { const c = this.duplicate(r.s); if (c) { st.pushUndo(`duplicate ${r.s.name}`, () => this.remove(c)); this.select({ kind: 'spawned', s: c }); } else st.toast('No room next to it for a copy', true); }
    if (a === 'remove') {
      if (r.kind === 'spawned') { const snap = this.snapshot(r.s); this.remove(r.s); st.pushUndo(`remove ${snap.name}`, () => { this.restore(snap); }); }
      if (r.kind === 'ai') { r.a.train.gone = true; st.toast(`${r.a.train.name ?? 'AI train'} removed`); this.render(); }
    }
  }

  /** The camera wants to follow a train (set by the cameras). */
  onFocus: ((r: TrainRef) => void) | null = null;
  /** a station was picked in the spawn form: the camera goes there (set by the studio) */
  onStation: ((code: string) => void) | null = null;
  /** is this train followed by a camera (set by the studio) */
  followed: ((s: Spawned) => boolean) | null = null;
  /** "Drive this train": hand it to the keyboard (set by the studio). */
  onDrive: ((r: TrainRef) => void) | null = null;

  drive(r: TrainRef) {
    if (r.kind === 'ai') {
      // take an AI train over: the same stock, as a Record Mode train where it is
      const a = r.a, coaches = new Map<string, number>();
      for (const v of a.view.vehicles) if (v.kind === 'coach') coaches.set(v.typeId, (coaches.get(v.typeId) ?? 0) + 1);
      const spec: ConsistSpec = { loco: a.view.loco.data.id, coaches: [...coaches].map(([type, count]) => ({ type, count })) };
      const km = a.route.canonicalKm(a.train.headKm), off = a.train.offsetAt(a.train.headKm), kmph = a.train.speed / KMPH;
      a.train.gone = true;
      a.view.group.visible = false;
      const s = this.spawn(spec, a.route.running.id, km, off, { mode: 'speed', kmph: Math.round(kmph), name: a.train.name });
      if (!s) return;
      s.t.speed = a.train.speed;
      r = { kind: 'spawned', s };
    }
    this.select(r);
    this.onDrive?.(r);
  }

  private cardAction(a: string) {
    const r = this.selected, h = this.host, st = this.st!;
    if (!r) return;
    const slider = this.el.querySelector<HTMLInputElement>('[data-s="kmph"]');
    const kmph = slider ? Number(slider.value) : 0;
    if (r.kind === 'player') {
      const s = h.player.sys;
      if (a === 'speed-now') { h.rec.playerDrive && (h.rec.playerDrive.kmph = kmph); h.player.setSpeedNow(kmph); }
      if (a === 'speed-gradual') st.apply(() => { if (h.rec.playerDrive) h.rec.playerDrive.kmph = kmph; });
      if (a === 'horn-short' || a === 'horn-long') { s.setHorn('low', true); setTimeout(() => s.setHorn('low', false), a === 'horn-long' ? 1800 : 400); }
      if (a === 'doors') h.player.toggleDoors();
      return;
    }
    if (r.kind !== 'spawned') return;
    const s = r.s, t = s.t;
    if (a === 'speed-now') { t.kmph = kmph; if (t.mode === 'parked') t.mode = 'speed'; t.speed = Math.min(kmph, s.loco.maxSpeedKmph) * KMPH; }
    if (a === 'speed-gradual') st.apply(() => { t.kmph = kmph; if (t.mode === 'parked') t.mode = 'speed'; });
    if (a === 'horn-short') this.horn(s, 0.4);
    if (a === 'horn-long') this.horn(s, 1.8);
    if (a === 'doors') { s.doors = !s.doors; this.render(); }
    if (a === 'path') { this.pathDraft = s.path ? structuredClone(s.path) : this.newPath(s); this.render(); }
    if (a === 'clear-path') { this.setPath(s, null); t.mode = 'speed'; }
    if (a === 'go') { t.held = false; this.render(); }
  }

  private cardInput(k: string, v: string | boolean) {
    const r = this.selected, h = this.host, st = this.st!;
    if (!r) return;
    if (r.kind === 'player') {
      const s = h.player.sys;
      if (k === 'pdrive') { h.rec.playerDrive = v ? { kmph: Math.round(Math.abs(h.player.speed()) * 3.6), style: 'normal', obeySignals: true, obeyLimits: true } : null; this.render(); return; }
      const pd = h.rec.playerDrive;
      if (pd && k === 'kmph') st.apply(() => { pd.kmph = Number(v); });
      if (pd && k === 'style') st.apply(() => { pd.style = v as DriveStyle; });
      if (pd && (k === 'obeySignals' || k === 'obeyLimits')) st.apply(() => { pd[k] = !!v; });
      if (k === 'headlight') s.headlight = Number(v);
      if (k === 'markers' && s.markers !== !!v) s.toggleMarkers();
      if (k === 'cabLight' && s.cabLight !== !!v) s.toggleCabLight();
      if (k === 'panto' && s.pantoUp !== !!v) s.togglePanto();
      if (k === 'engine' && (s.engine !== 'stopped') !== !!v) { if (v && !s.fuelPump) s.toggleFuelPump(); s.toggleEngine(); }
      return;
    }
    if (r.kind !== 'spawned') return;
    const s = r.s, t = s.t;
    switch (k) {
      case 'name': s.name = String(v).slice(0, 40) || s.name; t.name = s.name; break;
      case 'kmph': st.apply(() => { t.kmph = Number(v); }); break;
      case 'style': st.apply(() => { t.style = v as DriveStyle; }); break;
      case 'auto': st.apply(() => { t.mode = v ? 'auto' : 'speed'; }); break;
      case 'obeySignals': st.apply(() => { t.obeySignals = !!v; }); break;
      case 'obeyLimits': st.apply(() => { t.obeyLimits = !!v; }); break;
      case 'headlight': st.apply(() => { s.headlight = Number(v); }); break;
      case 'markers': st.apply(() => { s.markers = !!v; }); break;
      case 'cabLight': st.apply(() => { s.cabLight = !!v; }); break;
      case 'interior': st.apply(() => { s.interior = !!v; }); break;
      case 'autoHorn': s.autoHorn = !!v; break;
      case 'panto': st.apply(() => { s.panto = !!v; }); break;
      case 'engine': st.apply(() => { s.engine = !!v; }); break;
      case 'smoke': st.apply(() => { s.smokeAmt = Number(v); }); break;
      case 'loaded': st.apply(() => {
        s.spec.loaded = !!v;
        s.view.vehicles.forEach((veh, i) => { if (veh.kind === 'coach') s.view.setLook(i, !!v); });
      }); break;
    }
  }

  private pathAction(a: string) {
    const s = this.selectedSpawned(), p = this.pathDraft, st = this.st!;
    if (!s || !p) return;
    const r = s.t.route;
    const ahead = (hit: TrackHit) => { if (r.viewKm(hit.km) <= s.t.headKm + 0.02) { st.toast('That point is behind the train: trains run forward along their path', true); return false; } return true; };
    if (a === 'pick-dest') st.pick('Click the track where the path ends', hit => { if (!ahead(hit)) return; p.dest = { km: hit.km }; this.render(); });
    if (a === 'pick-via') st.pick('Click a point the path runs through', hit => {
      if (!ahead(hit)) return;
      const stn = r.stations.find(x => { const k = r.viewKm(hit.km); return k >= x.entryKm && k <= x.exitKm; });
      p.via.push({ km: hit.km, station: stn?.code, line: hit.line ?? undefined });
      this.render();
    });
    if (a === 'pick-marker') st.pick('Click where the train should stop', hit => { if (!ahead(hit)) return; p.markers.push({ km: hit.km, seconds: 10 }); this.render(); });
    if (a === 'pick-slow') st.pick('Click where the slow zone starts', a1 => {
      if (!ahead(a1)) return;
      st.pick('Click where it ends', a2 => { p.slow.push({ fromKm: Math.min(a1.km, a2.km), toKm: Math.max(a1.km, a2.km), kmph: 30 }); this.render(); });
    });
    if (a === 'apply') { this.setPath(s, p); this.pathDraft = null; this.render(); st.toast(`${s.name}: path set${p.start === 'go' ? ' - press Go (or Go all) to start' : ''}`); }
    if (a === 'cancel') { this.pathDraft = null; this.render(); }
  }

  dispose() {
    for (const s of [...this.list]) this.remove(s);
    for (const m of this.ribbonMat.values()) m.dispose();
  }
}

