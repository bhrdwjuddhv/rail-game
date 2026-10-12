import * as THREE from 'three/webgpu';
import { StationWork, WorkKind } from '@rail/shared/gameplay/StationWork';
import type { StopPlan } from '@rail/shared/gameplay/Timetable';
import type { Route, StationInfo } from '@rail/shared/track/Route';
import type { CoachData, Consist } from '@rail/shared/train/Consist';
import { formatClock } from '@rail/shared/util';
import { CoachDoors } from '../train/CoachDoors';
import type { TrainView } from '../train/Coach';
import { StopCard, StopView } from '../ui/StopCard';
import { LoadingWorks } from './LoadingWorks';

/** What the station stop needs from the game. */
export interface StopHost {
  route: () => Route;                       // the player's running-line view
  consist: Consist;
  coachTypes: Record<string, CoachData>;
  trainView: () => TrainView;
  plan: Map<string, StopPlan>;
  endStation: string | null;
  headKm: () => number;
  speed: () => number;
  offsetAt: (km: number) => number;
  clock: () => number;
  setClock: (s: number) => void;
  setWarp: (x: number) => void;
  /** the next signal ahead's aspect (R / Y / YY / G) */
  signalAhead: () => string | null;
  /** an AI train running towards this station on the player's line (km away), for loop waits */
  approaching: (st: StationInfo) => { name: string; km: number } | null;
  message: (text: string, kind?: 'info' | 'warn' | 'good') => void;
  whistle: () => void;
  doorSound: () => void;
  auto: () => boolean;
  scene: THREE.Object3D;
}

const LOADABLE = new Set(['boxcar', 'container']);

export class StationStop {
  readonly work: StationWork;
  readonly doors: CoachDoors;
  readonly card: StopCard;
  private st: StationInfo | null = null;
  private side = 1;
  private accuracy: string | null = null;
  private accuracyT = 0;
  private warpUntil: 'train' | 'dep' | null = null;
  private wagons: number[] = [];   // vehicle indices of loadable wagons, front to back
  private lamp: THREE.Mesh;
  private lampT = 0;
  private readyShownAt = -1;
  private works = new LoadingWorks();

  constructor(private h: StopHost, ui: HTMLElement, key: () => string | null) {
    const c = h.consist;
    const seats = c.vehicles.reduce((a, v) => { const t = h.coachTypes[v.typeId]; return a + (v.kind === 'coach' && (t?.kind ?? 'coach') === 'coach' ? t?.seats ?? 72 : 0); }, 0);
    c.vehicles.forEach((v, i) => { const t = h.coachTypes[v.typeId]; if (v.kind === 'coach' && t?.kind && LOADABLE.has(t.kind)) this.wagons.push(i); });
    const payload = this.wagons.reduce((a, i) => { const t = h.coachTypes[c.vehicles[i].typeId]; return a + (t.massLoadedT - t.massEmptyT); }, 0);
    const loaded = this.wagons.length ? c.vehicles[this.wagons[0]].loaded !== false : true;
    this.work = new StationWork(seats, this.wagons.length, Math.round(payload), loaded);
    this.work.onWagon = (w, isLoaded) => {
      const vi = this.wagons[w];
      c.setLoaded(vi, isLoaded, h.coachTypes);
      h.trainView().setLook(vi, isLoaded);
    };
    this.doors = new CoachDoors(c.vehicles, h.coachTypes);
    h.scene.add(this.doors.group, this.works.group); // vehicle matrices are in world (route) coordinates
    this.card = new StopCard(ui, id => this.press(id), key);
    // guard's green lamp at the rear, shown as the train is given the road
    this.lamp = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), new THREE.MeshBasicMaterial({ color: 0x40ff70 }));
    this.lamp.visible = false;
    h.trainView().group.add(this.lamp);
  }

  get passengerTrain() { return this.work.seats > 0; }
  get freightTrain() { return this.work.wagons > 0; }
  /** traction interlock: no power with doors open */
  get blocksTraction() { return this.work.doorsOpen; }

  /** Stopped at a booked stop (or standing there at the start). */
  arrive(st: StationInfo, origin: boolean) {
    const p = this.h.plan.get(st.code);
    if (!p?.stop) return;
    this.st = st;
    const end = this.h.endStation === st.code;
    const work: WorkKind[] = end ? [] : p.work ?? (this.passengerTrain ? ['board'] : []);
    const busy = st.type === 'halt' ? 0.3 : st.type === 'wayside' ? 0.55 : 1;
    this.work.arrive(st.code, work, { busy, festival: p.festival, origin });
    // which side the platform (or the yard) is: from the platform serving the train's line
    const off = this.h.offsetAt(this.h.headKm());
    const line = st.lineInfo.reduce((b, l) => (Math.abs(l.offset - off) < Math.abs(b.offset - off) ? l : b)).id;
    const pf = st.platforms.find(x => x.lines.includes(line)) ?? st.platforms.reduce((b, x) => (Math.abs(x.from - off) < Math.abs(b.from - off) ? x : b));
    this.side = Math.sign(pf.from - off) || 1;
    if (!origin) {
      const err = (this.h.headKm() - this.h.route().stopKm(st, this.h.consist.length)) * 1000;
      this.accuracy = Math.abs(err) <= 2 ? 'Stopped on the mark &#10003;' : err > 0 ? `Overshot by ${Math.round(err)} m` : `Stopped ${Math.round(-err)} m short`;
      this.accuracyT = 8;
    }
    this.readyShownAt = -1;
  }

  leave() {
    if (!this.st) return;
    this.st = null;
    this.work.leave();
    this.h.setWarp(1);
    this.warpUntil = null;
  }

  private press(id: 'start' | 'close' | 'fast' | 'skip') {
    const w = this.work;
    if (id === 'start') { w.start(); if (w.doorsOpen) this.h.doorSound(); }
    if (id === 'close' && w.close()) { this.h.doorSound(); this.h.whistle(); this.lampT = 8; }
    if (id === 'fast') w.fast = !w.fast;
    if (id === 'skip') this.skip();
  }

  /** T key: open the doors / start loading, or close the doors. */
  toggle() {
    const ph = this.work.phase;
    if (ph === 'ready') this.press('start');
    else if (ph === 'done' && this.work.doorsOpen) this.press('close');
  }

  private skip() {
    const st = this.st, p = st && this.h.plan.get(st.code);
    if (!st || !p) return;
    const a = this.h.approaching(st);
    if (a) { this.warpUntil = 'train'; this.h.setWarp(8); return; }
    // nothing to wait for but the clock: jump to just before the booked time
    if (p.dep !== undefined && this.h.clock() < p.dep - 10) this.h.setClock(p.dep - 10);
  }

  update(dt: number) {
    const w = this.work;
    w.update(dt);
    if (this.h.auto() && this.st) {
      // God Mode auto-drive: the stop works itself
      if (w.phase === 'ready') this.press('start');
      else if (w.phase === 'done' && w.doorsOpen) this.press('close');
    }
    // the train left the platform: the stop is over
    if (this.st && Math.abs(this.h.speed()) > 0.5 && w.phase !== 'working') this.leave();
    // doors
    this.doors.open += ((w.doorsOpen || (w.job && w.job.kind !== 'board' && this.wagonDoors()) ? 1 : 0) - this.doors.open) * Math.min(1, dt * 2.2);
    this.doors.update(this.h.trainView().vehicleMatrices, this.side);
    // the wagon being worked: crane (containers) or forklift (covered wagons)
    const j = w.job;
    if (j && j.kind !== 'board' && this.wagons.length) {
      const n = this.wagons.length, at = Math.min(n - 1, Math.floor(j.progress * n)), vi = this.wagons[at];
      const kind = this.h.coachTypes[this.h.consist.vehicles[vi].typeId]?.kind;
      this.works.update({ kind: j.kind, wagon: this.h.trainView().vehicleMatrices[vi], containers: kind === 'container', u: j.progress * n - at }, this.side);
    } else this.works.update(null, this.side);
    // the warp ends when the other train is close (it is seen passing) or the booked time is reached
    if (this.warpUntil && this.st) {
      const a = this.h.approaching(this.st), p = this.h.plan.get(this.st.code);
      if (!a || a.km < 1.0 || (p?.dep !== undefined && this.h.clock() >= p.dep - 10)) { this.h.setWarp(1); this.warpUntil = null; }
    }
    // guard's lamp at the rear
    this.lampT -= dt;
    this.lamp.visible = this.lampT > 0;
    if (this.lamp.visible) {
      const vs = this.h.consist.vehicles, last = vs.length - 1, m = this.h.trainView().vehicleMatrices[last];
      this.lamp.position.set(-(vs[last].length / 2) + 0.2, 2.4, this.side * 1.45).applyMatrix4(m).sub(this.h.trainView().group.position);
    }
    this.accuracyT -= dt;
    this.card.update(this.view());
  }

  /** covered wagons open their doors while they are worked */
  private wagonDoors() { return this.wagons.some(i => this.h.coachTypes[this.h.consist.vehicles[i].typeId]?.kind === 'boxcar'); }

  private view(): StopView | null {
    const st = this.st, w = this.work;
    if (!st) return null;
    const p = this.h.plan.get(st.code);
    const v: StopView = { accuracy: this.accuracyT > 0 ? this.accuracy : null, action: null, progress: null, wait: null, status: null };
    const ph = w.phase, j = w.job;
    if (ph === 'ready') {
      const next = (p?.work ?? ['board'])[0];
      v.action = { id: 'start', label: next === 'load' ? 'Start loading' : next === 'unload' ? 'Start unloading' : 'Open doors' };
    }
    if (j) {
      const pct = Math.round(j.progress * 100);
      v.progress = j.kind === 'board'
        ? { text: `Boarding... ${pct}% &nbsp; &darr; ${Math.round(j.off * Math.min(1, j.progress * 2))} &nbsp; &uarr; ${Math.round(j.on * Math.max(0, j.progress * 2 - 1))}`, value: j.progress, fast: w.fast }
        : { text: `${j.kind === 'load' ? 'Loading' : 'Unloading'}... ${pct}% &mdash; ${Math.round(w.cargo).toLocaleString('en-IN')} t / ${w.payloadT.toLocaleString('en-IN')} t`, value: j.progress, fast: w.fast };
    }
    if (ph === 'done' && w.doorsOpen) v.action = { id: 'close', label: 'Close doors' };
    if (ph === 'closed' || ph === 'none' || (ph === 'done' && !w.doorsOpen)) {
      const clock = this.h.clock(), a = this.h.approaching(st);
      if (this.st && this.h.endStation === st.code) return v.accuracy ? v : null;
      if (a && (p?.dep === undefined || clock < p.dep - 10 || a.km < 2.5)) v.wait = { text: `Waiting for ${a.name} to pass (${a.km.toFixed(1)} km)`, skip: this.warpUntil ? 'Skipping...' : 'Skip wait' };
      else if (p?.dep !== undefined && clock < p.dep - 10) v.wait = { text: `Scheduled departure ${formatClock(p.dep)}`, skip: 'Skip to departure' };
      else {
        const asp = this.h.signalAhead();
        if (asp && asp !== 'R') {
          if (this.readyShownAt < 0) this.readyShownAt = clock;
          if (clock - this.readyShownAt < 6) v.status = 'Ready to depart';
        } else v.status = 'Waiting for the signal...';
      }
    }
    return v.accuracy || v.action || v.progress || v.wait || v.status ? v : null;
  }

  /** passengers aboard / cargo, for the HUD's station line */
  get summary() {
    if (this.passengerTrain) return `${this.work.liveCount} aboard`;
    if (this.freightTrain) return `${Math.round((this.h.consist.mass) / 1000).toLocaleString('en-IN')} t`;
    return '';
  }

  dispose() { this.card.el.remove(); this.doors.group.removeFromParent(); this.works.group.removeFromParent(); this.lamp.removeFromParent(); }
}
