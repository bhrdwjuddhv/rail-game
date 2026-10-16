import * as THREE from 'three/webgpu';
import { bus } from '@rail/shared/events';
import { COACHES, LOCOS } from '../data';
import { TrainView } from '../train/Coach';
import type { ConsistSpec, LocoData, Vehicle } from '@rail/shared/train/Consist';
import type { Journey, JourneyStop } from '@rail/shared/routemode/Journey';
import type { Route } from '@rail/shared/track/Route';
import type { LineControl } from '@rail/shared/signalling/Control';
import type { WorkedTrain } from '@rail/shared/gameplay/Timetable';
import { newFrame } from '@rail/shared/track/Chainage';
import { icon } from '../ui/theme/icons';
import { formatClock } from '@rail/shared/util';

/** What the game gives a journey run. */
export interface JourneyHost {
  route(): Route;
  head(): number; tail(): number; speed(): number;
  /** auto shunt: hold the train to this speed (m/s, after the physics step) */
  setSpeed(v: number): void;
  offsetAt(km: number): number;
  vehicles(): Vehicle[];
  spec(): ConsistSpec;
  rebuildTrain(spec: ConsistSpec): void;
  arrived(code: string): boolean; departed(code: string): boolean;
  stopKm(code: string): number | null;
  /** the player's train's loco drawn or not (a loco change) */
  showLoco(on: boolean): void;
  lc(): LineControl;
  /** keep the dispatcher's hands off a parked rake */
  manual(id: string): void;
  world: THREE.Object3D;
  ui: HTMLElement;
  addCompiled(o: THREE.Object3D): void;
  freeCam(eye: THREE.Vector3, target: THREE.Vector3): void;
  /** back to the camera the player had (after watching the shunting) */
  restoreCamera(): void;
  setPlan(code: string, stop: boolean, dwellS: number): void;
  continueWith(j: Journey): void;
  finish(s: JourneySummary): void;
  message(text: string, kind?: 'info' | 'warn' | 'good' | 'penalty'): void;
  clock(): number;
}

export interface JourneySummary { title: string; minutes: number; km: number; stops: { name: string; errM: number }[]; bumps: number; smooth: number }

/** a drawn train moving by itself (rakes being shunted, locos changing) */
interface Mover { view: TrainView; head: number; target: number; v: number; vmax: number; occ?: WorkedTrain; done?: () => void; hold?: boolean; remove?: boolean }

const COUPLE_KMPH = 5, BUMP_KMPH = 8;

/**
 * A Route Mode journey in the game: a card with the next stop and the next planned action, the actions
 * themselves at their stations (leave coaches behind, pick up coaches shunted in behind the train,
 * change the loco), and the summary at the end. The plan for stations ahead can be changed from the
 * pause menu.
 */
export class JourneyRun {
  private card = document.createElement('div');
  private done = new Set<string>();
  private arrivedSeen = new Map<string, number>();
  private movers: Mover[] = [];
  private couple: { code: string; types: string[]; rake: Mover | null; phase: 'clearing' | 'coming' | 'waiting'; auto: boolean; active: Mover[] } | null = null;
  /** coaches left standing at a station (decoupled there): cleared away before new ones are brought in */
  private parkedAt = new Map<string, { mover: Mover; types: string[] }>();
  /** the shunting camera: on, how fast the shunting runs (0.5x .. 4x) */
  private watching = false;
  private shuntRate = 1;
  private ctl = document.createElement('div');
  private locoChange: { code: string; to: string; phase: 'out' | 'in' | 'coupled'; t: number } | null = null;
  private bumps = 0;
  private joltSum = 0;
  private ended = false;
  private hereSince = new Map<string, number>();
  private uiT = 0;
  private parkedN = 0;
  private off: () => void;

  constructor(private h: JourneyHost, readonly j: Journey) {
    this.card.className = 'journey-card';
    h.ui.appendChild(this.card);
    this.card.addEventListener('click', e => {
      const a = (e.target as HTMLElement).closest<HTMLElement>('[data-ja]')?.dataset.ja;
      if (a) this.act(a);
    });
    // the shunting camera's own controls: speed, skip, back to the train
    this.ctl.className = 'shunt-ctl';
    this.ctl.hidden = true;
    this.ctl.innerHTML = `<label><span>${icon('fastForward')} Shunting speed</span><input type="range" min="0.5" max="4" step="0.25" value="1" data-sh="rate"><output>1×</output></label>
      <button data-sh="skip">${icon('fastForward')}Skip</button><button data-sh="back">${icon('train')}Back to the train</button>`;
    h.ui.appendChild(this.ctl);
    this.ctl.addEventListener('input', e => {
      const t = e.target as HTMLInputElement;
      if (t.dataset.sh === 'rate') { this.shuntRate = Number(t.value); t.nextElementSibling!.textContent = `${t.value}×`; }
    });
    this.ctl.addEventListener('click', e => {
      const a = (e.target as HTMLElement).closest<HTMLElement>('[data-sh]')?.dataset.sh;
      if (a === 'skip') this.skipShunting();
      if (a === 'back') this.watch(false);
    });
    this.off = bus.on('coupler-jolt', e => { if (e.magnitude > 0.5) this.joltSum += e.magnitude; });
    this.start = h.clock();
    this.startKm = h.head();
  }

  dispose() { this.off(); this.card.remove(); this.ctl.remove(); }

  /** Is the train to wait here: planned work not done yet (the dispatcher holds its departure)? */
  holds(code: string) {
    const s = this.stops().find(x => x.code === code);
    return this.couple?.code === code || this.locoChange?.code === code || (!!s && this.pending(s).length > 0);
  }

  /** anything shunting by itself right now */
  private shunting() { return this.movers.some(m => !m.hold && Math.abs(m.target - m.head) > 1e-5); }

  /** The shunting camera: beside the line, following the shunter; its controls on screen. */
  private watch(on: boolean) {
    if (on === this.watching) return;
    this.watching = on;
    this.ctl.hidden = !on;
    if (!on) this.h.restoreCamera();
  }

  /** Skip: every shunting move done at once (each one's next step starts and is done too). */
  private skipShunting() {
    for (let i = 0; i < 20 && this.shunting(); i++) {
      for (const m of [...this.movers]) {
        if (m.hold || Math.abs(m.target - m.head) <= 1e-5) continue;
        m.head = m.target; m.v = 0;
        m.done?.();
      }
      for (const m of this.movers.filter(x => x.remove)) this.drop(m);
    }
  }

  private stops() { return this.j.stops.filter(s => s.stop); }
  private name(code: string) { return this.h.route().station(code)?.name ?? code; }
  /** the planned stop the train is standing at (arrived, not yet left) */
  private here() { return this.stops().find(s => this.h.arrived(s.code) && !this.h.departed(s.code)) ?? null; }
  private pending(s: JourneyStop) {
    const out: ('decouple' | 'couple' | 'loco')[] = [];
    if (s.decouple && !this.done.has(`${s.code}:decouple`)) out.push('decouple');
    if (s.couple?.length && !this.done.has(`${s.code}:couple`)) out.push('couple');
    if (s.changeLoco && !this.done.has(`${s.code}:loco`)) out.push('loco');
    return out;
  }
  private actionText(s: JourneyStop, a: 'decouple' | 'couple' | 'loco') {
    if (a === 'decouple') return `${icon('decouple')} Leave the last ${s.decouple} at ${this.name(s.code)}`;
    if (a === 'couple') return `${icon('couple')} Pick up ${s.couple![0].count} ${COACHES[s.couple![0].type]?.name ?? ''} at ${this.name(s.code)}`;
    return `${icon('loco')} Change to ${LOCOS[s.changeLoco!]?.name ?? s.changeLoco} at ${this.name(s.code)}`;
  }

  /** Pause menu: a new plan for the stations still ahead. */
  setStops(stops: JourneyStop[]) {
    for (const s0 of stops) {
      const s = this.h.route().station(s0.code)?.junction ? { ...s0, stop: true } : s0; // junctions are always stops
      if (this.h.arrived(s.code) && s.code !== this.here()?.code) continue;
      const i = this.j.stops.findIndex(x => x.code === s.code);
      if (i >= 0) this.j.stops[i] = s; else this.j.stops.push(s);
      if (s.code !== this.j.from) this.h.setPlan(s.code, s.stop, s.dwellS);
    }
  }
  /** stations still ahead (for the plan editor) */
  ahead() { const st = this.h.route().stations; return this.j.stops.map(s => s.code).filter(c => !this.h.departed(c) && c !== this.j.from && st.some(x => x.code === c)); }

  // ---------------------------------------------------------------- per frame
  update(dt: number, night: number) {
    const h = this.h, r = h.route();
    // arrivals: how far from the mark
    for (const s of this.stops()) {
      if (s.code === this.j.from || this.arrivedSeen.has(s.code) || !h.arrived(s.code)) continue;
      const k = h.stopKm(s.code);
      this.arrivedSeen.set(s.code, k === null ? 0 : (h.head() - k) * 1000);
    }
    if (!this.ended && h.arrived(this.j.to)) { this.ended = true; this.finish(); }
    // actions at the station the train stands at (auto shunt starts them by itself after a moment)
    const here = this.here();
    if (here) {
      if (!this.hereSince.has(here.code)) this.hereSince.set(here.code, h.clock());
      const p = this.pending(here), waited = h.clock() - this.hereSince.get(here.code)!;
      if (this.j.autoShunt && p.length && !this.couple && !this.locoChange && waited > 8) this.act(p[0]);
    }
    if (this.couple && h.departed(this.couple.code)) {
      h.message(this.couple.phase === 'waiting' ? 'The waiting coaches stay behind (the train left without them)' : 'Shunting called off: the train has left', 'warn');
      for (const m of this.couple.active) if (this.movers.includes(m) && !m.hold) this.drop(m);
      this.done.add(`${this.couple.code}:couple`);
      this.couple = null;
      this.watch(false);
    }
    // movers: rakes and locos shunting by themselves (at the shunting speed chosen)
    const sdt = dt * this.shuntRate;
    for (const m of [...this.movers]) {
      if (!m.hold && Math.abs(m.target - m.head) > 1e-5) {
        const dt = sdt;
        const left = (m.target - m.head) * 1000, dir = Math.sign(left);
        m.v = Math.min(m.vmax, m.v + 0.5 * dt, Math.sqrt(2 * 0.35 * Math.abs(left)));
        m.head += (dir * Math.min(Math.abs(left), m.v * dt)) / 1000;
        if (Math.abs(m.target - m.head) < 1e-5) { m.v = 0; m.done?.(); }
      }
      if (m.occ) { (m.occ as { headKm: number }).headKm = m.head; }
      m.view.update(r, m.head, km => h.offsetAt(km), m.head * 1000, night);
    }
    for (const m of this.movers.filter(x => x.remove)) this.drop(m);
    if (this.locoChange) this.updateLocoChange(dt);
    // the shunting camera follows the moving shunter; back to the train once the moves are over
    if (this.watching) {
      const m = this.movers.find(x => !x.hold && Math.abs(x.target - x.head) > 1e-5);
      if (!m) this.watch(false);
      else {
        const f = newFrame(), off = h.offsetAt(m.head);
        r.alignment.sampleOffset((m.head - 0.05) * 1000, off - 18, f);
        const eye = new THREE.Vector3(f.x, f.y + 6, f.z);
        r.alignment.sampleOffset(m.head * 1000, off, f);
        h.freeCam(eye, new THREE.Vector3(f.x, f.y + 2, f.z));
      }
    }
    this.uiT -= dt;
    if (this.uiT <= 0) { this.uiT = 0.25; this.drawCard(); }
  }

  /** after the physics step: auto shunt holds the speed, and the couplers meet */
  afterStep() {
    const c = this.couple;
    if (!c || c.phase !== 'waiting' || !c.rake) return;
    const gap = (this.h.tail() - c.rake.head) * 1000;
    if (c.auto) this.h.setSpeed(-Math.min(1.35, Math.max(0.35, gap * 0.06)));
    if (gap <= 0.3) this.coupled(gap);
  }

  private drawCard() {
    const h = this.h, here = this.here();
    const next = this.stops().find(s => s.code !== this.j.from && !h.arrived(s.code));
    const rows: string[] = [];
    if (next) {
      const st = h.route().station(next.code), k = h.stopKm(next.code);
      rows.push(`<div class="jc-row">${icon('platform')}<span>Next stop <b>${st?.name ?? next.code}</b>${k !== null ? ` · ${Math.max(0, k - h.head()).toFixed(1)} km` : ''}</span></div>`);
    }
    // the next planned action (here, or ahead)
    const withActs = this.stops().filter(s => !h.departed(s.code) && this.pending(s).length);
    const nextAct = withActs[0];
    const btns: string[] = [];
    if (here && this.pending(here).length && !this.couple && !this.locoChange) {
      for (const a of this.pending(here)) btns.push(`<button data-ja="${a}">${a === 'decouple' ? `${icon('decouple')}Decouple ${here.decouple}` : a === 'couple' ? `${icon('couple')}Pick up the coaches` : `${icon('loco')}Change loco`}</button>`);
      rows.push(`<div class="jc-row jc-act">${this.actionText(here, this.pending(here)[0])}</div>`);
    } else if (nextAct) rows.push(`<div class="jc-row jc-act">${this.actionText(nextAct, this.pending(nextAct)[0])}</div>`);
    const c = this.couple;
    if (c?.phase === 'clearing') rows.push(`<div class="jc-row jc-act">${icon('couple')} A shunter is drawing the coaches left here away to the yard…</div>`);
    if (c?.phase === 'coming') rows.push(`<div class="jc-row jc-act">${icon('couple')} The coaches are being shunted in behind your train…</div>`);
    if (this.shunting() && !this.watching) btns.push(`<button data-ja="watch">${icon('videoCamera')}See shunting</button>`);
    if (c?.phase === 'waiting' && c.rake) {
      const gap = Math.max(0, (h.tail() - c.rake.head) * 1000), kmph = Math.abs(h.speed()) * 3.6;
      rows.push(`<div class="jc-row jc-guide${kmph > COUPLE_KMPH ? ' fast' : ''}">${icon('couple')}<span>${c.auto ? 'Auto shunt: backing onto the coaches' : 'Reverser to R, back up gently (under 5 km/h)'}</span><b>${gap.toFixed(gap < 10 ? 1 : 0)} m</b><small>${kmph.toFixed(1)} km/h</small></div>`);
      if (!c.auto) btns.push(`<button data-ja="auto">${icon('lightning')}Auto shunt</button>`);
    }
    if (this.locoChange) rows.push(`<div class="jc-row jc-act">${icon('loco')} ${this.locoChange.phase === 'out' ? 'The old loco goes off to the shed…' : this.locoChange.phase === 'in' ? `${LOCOS[this.locoChange.to]?.name} is backing onto your train…` : 'Coupled. Getting ready…'}</div>`);
    const html = `${rows.join('')}${btns.length ? `<div class="jc-btns">${btns.join('')}</div>` : ''}`;
    if (this.card.innerHTML !== html) this.card.innerHTML = html;
    this.card.hidden = !rows.length;
  }

  // ---------------------------------------------------------------- the actions
  private act(a: string) {
    const here = this.here();
    if (a === 'auto' && this.couple) { this.couple.auto = true; return; }
    if (a === 'watch') { this.watch(true); return; }
    if (!here) return;
    if (a === 'decouple') this.decouple(here);
    if (a === 'couple') this.startCouple(here);
    if (a === 'loco') this.startLocoChange(here);
  }

  private coachTypes() { return this.h.vehicles().filter(v => v.kind === 'coach').map(v => v.typeId); }
  private specOf(types: string[]): ConsistSpec {
    const runs: ConsistSpec['coaches'] = [];
    for (const t of types) { const last = runs[runs.length - 1]; if (last?.type === t) last.count++; else runs.push({ type: t, count: 1 }); }
    return { ...this.h.spec(), coaches: runs };
  }
  /** a drawn train of these vehicles (front first), and its occupant in the signalling */
  private mover(vehicles: Vehicle[], loco: LocoData, head: number, park: boolean): Mover {
    const view = new TrainView(vehicles, loco, COACHES, 'passenger', false);
    this.h.world.add(view.group);
    this.h.addCompiled(view.group);
    const len = vehicles.reduce((a, v) => a + v.length, 0) / 1000;
    let occ: WorkedTrain | undefined;
    if (park) {
      const m = { head };
      const id = `rm-rake-${++this.parkedN}`;
      occ = { id, plan: new Map(), speed: 0, priority: 1, get headKm() { return m.head; }, set headKm(v: number) { m.head = v; }, get tailKm() { return m.head - len; }, offsetAt: (km: number) => this.h.offsetAt(km) } as unknown as WorkedTrain;
      this.h.manual(id);
      this.h.lc().add(occ);
    }
    const mv: Mover = { view, head, target: head, v: 0, vmax: 3, occ };
    this.movers.push(mv);
    return mv;
  }
  private drop(m: Mover) {
    this.movers.splice(this.movers.indexOf(m), 1);
    m.view.group.removeFromParent();
    m.view.group.traverse(o => { if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose(); });
    if (m.occ) this.h.lc().remove(m.occ);
  }
  private build(types: string[], locoAtRear?: LocoData): Vehicle[] {
    const out: Vehicle[] = [];
    let off = 0;
    for (const t of types) {
      const c = COACHES[t];
      if (!c) continue;
      out.push({ kind: 'coach', typeId: t, massKg: 0, length: c.lengthM, frontOffset: off, bogieCentres: c.bogieCentresM, axleSpacing: c.axleSpacingM, maxBrakeN: 0, davis: { a: 0, b: 0, c: 0 } });
      off += c.lengthM;
    }
    if (locoAtRear) out.push({ kind: 'loco', typeId: locoAtRear.id, massKg: 0, length: locoAtRear.lengthM, frontOffset: off, bogieCentres: locoAtRear.bogieCentresM, axleSpacing: locoAtRear.axleSpacingM, maxBrakeN: 0, davis: { a: 0, b: 0, c: 0 }, reversed: true });
    return out;
  }

  /** Leave the last N coaches standing where they are; the train goes on without them. */
  private decouple(s: JourneyStop) {
    const types = this.coachTypes(), n = Math.min(s.decouple ?? 0, types.length - 1);
    if (n <= 0) { this.done.add(`${s.code}:decouple`); return; }
    const vs = this.h.vehicles(), firstRear = vs[vs.length - n];
    const rakeHead = this.h.head() - firstRear.frontOffset / 1000;
    const left = types.slice(types.length - n);
    this.h.rebuildTrain(this.specOf(types.slice(0, types.length - n)));
    // (a rake of coaches only: no loco of its own)
    const parked = this.mover(this.build(left), LOCOS[this.h.spec().loco], rakeHead, true);
    parked.hold = true;
    this.parkedAt.set(s.code, { mover: parked, types: left });
    this.done.add(`${s.code}:decouple`);
    this.h.message(`Decoupled: ${n} ${n === 1 ? 'vehicle stays' : 'vehicles stay'} at ${this.name(s.code)}`, 'good');
  }

  /** a loco alone, facing up the line */
  private locoOnly(l: LocoData): Vehicle[] { return [{ kind: 'loco', typeId: l.id, massKg: 0, length: l.lengthM, frontOffset: 0, bogieCentres: l.bogieCentresM, axleSpacing: l.axleSpacingM, maxBrakeN: 0, davis: { a: 0, b: 0, c: 0 } }]; }

  /**
   * The waiting coaches are propelled in behind the train by a shunter, which then goes; the train backs onto
   * them. Coaches left here earlier (decoupled) stand in the way: the shunter first draws them off to the yard.
   */
  private startCouple(s: JourneyStop) {
    const types = s.couple!.flatMap(c => Array<string>(c.count).fill(c.type)).filter(t => COACHES[t]);
    if (!types.length) { this.done.add(`${s.code}:couple`); return; }
    const shunter = LOCOS['wdm-3d'] ?? Object.values(LOCOS).find(l => !l.trainset)!;
    const c = this.couple = { code: s.code, types, rake: null as Mover | null, phase: 'coming' as 'clearing' | 'coming' | 'waiting', auto: this.j.autoShunt, active: [] as Mover[] };
    const left = this.parkedAt.get(s.code);
    if (left) {
      c.phase = 'clearing';
      const len = left.types.reduce((a, t) => a + COACHES[t].lengthM, 0) / 1000, tail = left.mover.head - len;
      const sh = this.mover(this.locoOnly(shunter), shunter, tail - 0.4, false);
      sh.target = tail - 0.0003; sh.vmax = 4;
      c.active.push(sh);
      sh.done = () => {
        // coupled on: shunter and coaches go back up the line together, out of the way
        this.drop(sh); this.drop(left.mover); this.parkedAt.delete(s.code);
        const away = this.mover(this.build(left.types, shunter), shunter, left.mover.head, false);
        away.target = left.mover.head - 0.65; away.vmax = 4;
        c.active.push(away);
        away.done = () => { away.remove = true; if (this.couple === c) this.bringCoaches(c, shunter); };
      };
    } else this.bringCoaches(c, shunter);
  }

  private bringCoaches(c: NonNullable<JourneyRun['couple']>, shunter: LocoData) {
    const types = c.types;
    c.phase = 'coming';
    const final = this.h.tail() - 0.05, start = final - 0.45;
    const rake = this.mover(this.build(types, shunter), shunter, start, true);
    rake.target = final; rake.vmax = 3.5;
    c.rake = rake;
    c.active.push(rake);
    rake.done = () => {
      // the shunter uncouples and goes back the way it came; the coaches stay, brakes on
      const len = types.reduce((a, t) => a + COACHES[t].lengthM, 0) / 1000;
      this.drop(rake);
      const coaches = this.mover(this.build(types), shunter, final, true);
      coaches.hold = true;
      const sh = this.mover(this.locoOnly(shunter), shunter, final - len, false);
      sh.target = final - len - 0.4; sh.vmax = 4;
      sh.done = () => { sh.remove = true; };
      c.active.push(sh);
      if (this.couple) { this.couple.rake = coaches; this.couple.phase = 'waiting'; }
      this.h.message(this.couple?.auto ? 'The coaches are ready: auto shunt backs onto them' : 'The coaches are ready behind you: put the reverser to R and back up gently', 'info');
    };
  }

  private coupled(gap: number) {
    const c = this.couple!, kmph = Math.abs(this.h.speed()) * 3.6;
    if (kmph > BUMP_KMPH || gap < -1) {
      this.bumps++;
      bus.emit('coupler-jolt', { magnitude: 1 });
      this.h.message(`Hard bump at ${kmph.toFixed(0)} km/h! Couple below ${COUPLE_KMPH} km/h`, 'warn');
    } else this.h.message('Coupled ✓', 'good');
    this.h.setSpeed(0);
    this.drop(c.rake!);
    this.h.rebuildTrain(this.specOf([...this.coachTypes(), ...c.types]));
    this.done.add(`${c.code}:couple`);
    this.couple = null;
  }

  /** The old loco runs off to the shed, the new one backs onto the train; then the journey goes on with it. */
  private startLocoChange(s: JourneyStop) {
    const to = LOCOS[s.changeLoco!], from = LOCOS[this.h.spec().loco];
    if (!to || !from) { this.done.add(`${s.code}:loco`); return; }
    const head = this.h.head(), r = this.h.route();
    this.h.showLoco(false);
    const old = this.mover(this.build([]).concat([{ kind: 'loco', typeId: from.id, massKg: 0, length: from.lengthM, frontOffset: 0, bogieCentres: from.bogieCentresM, axleSpacing: from.axleSpacingM, maxBrakeN: 0, davis: { a: 0, b: 0, c: 0 } }]), from, head, false);
    old.target = head + 0.22; old.vmax = 5;
    old.done = () => { old.remove = true; };
    this.locoChange = { code: s.code, to: to.id, phase: 'out', t: 0 };
    // a camera beside the loco end of the train
    const f = newFrame();
    r.alignment.sampleOffset((head - 0.03) * 1000, this.h.offsetAt(head) - 16, f);
    const eye = new THREE.Vector3(f.x, f.y + 5, f.z);
    r.alignment.sampleOffset((head + 0.04) * 1000, this.h.offsetAt(head), f);
    this.h.freeCam(eye, new THREE.Vector3(f.x, f.y + 2, f.z));
  }

  private updateLocoChange(dt: number) {
    const lc = this.locoChange!, head = this.h.head();
    lc.t += dt;
    if (lc.phase === 'out' && lc.t > 9) {
      lc.phase = 'in'; lc.t = 0;
      const to = LOCOS[lc.to], fromLen = LOCOS[this.h.spec().loco].lengthM;
      const nv = this.mover([{ kind: 'loco', typeId: to.id, massKg: 0, length: to.lengthM, frontOffset: 0, bogieCentres: to.bogieCentresM, axleSpacing: to.axleSpacingM, maxBrakeN: 0, davis: { a: 0, b: 0, c: 0 } }], to, head + 0.3, false);
      // its rear meets the first coach (where the old loco's rear was)
      nv.target = head - fromLen / 1000 + to.lengthM / 1000; nv.vmax = 3;
      nv.done = () => { lc.phase = 'coupled'; lc.t = 0; this.h.message(`Coupled ✓ ${to.name}`, 'good'); };
    }
    if (lc.phase === 'coupled' && lc.t > 2.5) {
      this.locoChange = null;
      this.done.add(`${lc.code}:loco`);
      this.continueFrom(lc.code, lc.to);
    }
  }

  /** The journey from this junction on with the new loco (a fresh start there; what was done so far is carried). */
  private continueFrom(code: string, loco: string) {
    const st = this.h.route().station(code)!, idx = this.j.via.indexOf(st.junction?.id ?? '');
    const s = this.summaryNow();
    const next: Journey = {
      ...this.j, from: code, via: idx >= 0 ? this.j.via.slice(idx + 1) : this.j.via,
      time: formatClock(this.h.clock() % 86400).slice(0, 5),
      consist: { ...this.h.spec(), loco },
      stops: this.j.stops.filter(x => !this.h.departed(x.code) && x.code !== this.j.from).map(x => (x.code === code ? { ...x, changeLoco: undefined, decouple: undefined, couple: undefined, stop: true, dwellS: 30 } : x)),
      carry: { title: this.j.carry?.title ?? this.title(), minutes: s.minutes, km: s.km, stops: s.stops, bumps: s.bumps, jolt: this.joltSum + (this.j.carry?.jolt ?? 0) },
    };
    this.h.continueWith(next);
  }

  private start = 0;
  private startKm = 0;
  private title() { return `${this.name(this.j.from)} → ${this.name(this.j.to)}`; }
  private summaryNow() {
    const c = this.j.carry;
    const stops = [...(c?.stops ?? []), ...[...this.arrivedSeen].map(([code, errM]) => ({ name: this.name(code), errM }))];
    return { minutes: (c?.minutes ?? 0) + (this.h.clock() - this.start) / 60, km: (c?.km ?? 0) + (this.h.head() - this.startKm), stops, bumps: (c?.bumps ?? 0) + this.bumps };
  }
  private finish() {
    const s = this.summaryNow(), jolt = this.joltSum + (this.j.carry?.jolt ?? 0);
    this.h.finish({ title: this.j.carry?.title ?? this.title(), ...s, smooth: Math.max(0, Math.round(100 - jolt * 6 - s.bumps * 10)) });
  }
}
