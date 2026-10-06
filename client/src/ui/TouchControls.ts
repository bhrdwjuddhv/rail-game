import { bus } from '@rail/shared/events';
import { BRAKE_POSITIONS } from '@rail/shared/physics/BrakeSystem';
import type { LocoSystems } from '@rail/shared/train/LocoSystems';
import type { Action } from '../core/Settings';
import { buzz } from '../input/Device';
import { CameraPicker } from './mobile/CameraPicker';
import { ControlBar } from './mobile/ControlBar';
import { h, onTap, setText } from './mobile/dom';
import { ICON } from './mobile/icons';
import { ScoreBadge, SpeedLimitCard, StationCard, TimetableCard, TimetableInfo } from './mobile/InfoCards';
import { Lever } from './mobile/Lever';
import { ReverserSwitch } from './mobile/ReverserSwitch';
import { SignalCard } from './mobile/SignalCard';
import { Speedometer } from './mobile/Speedometer';

/** What the touch layer needs from the game. */
export interface TouchHooks {
  sys: LocoSystems;
  notches: number;
  /** train brake handle position (index into BRAKE_POSITIONS) and loco brake 0..1 */
  brake(): { handle: number; independent: number };
  /** same as a key press / release */
  act(a: Action, down: boolean): void;
  setReverser(r: -1 | 0 | 1): void;
  /** select camera by index (0 cab, 1 front, 2 rear, 3 side, 4 chase, 5 cinematic, 6 free) */
  camera(i: number): void;
  cameraIndex(): number;
  pause(): void;
  /** show/hide the full HUD detail card and the minimap */
  toggleDetails(): void;
  toggleMap(): void;
  autoHide(): boolean;
  /** 'right': both levers on the right (default); 'split': throttle on the left edge for two thumbs */
  leverLayout(): 'right' | 'split';
}

/** Everything the HUD shows, computed by the game (no game logic here). */
export interface MobileHudData {
  speed: number; units: string; limit: number; maxKmph: number;
  signal: { aspect: string; dist: number } | null;
  restriction: { kmph: number; dist: number } | null;
  station: { name: string; dist: number } | null;
  timetable: TimetableInfo;
  score: number | null;
  vigilance: 'ok' | 'warning' | 'penalty';
}

const FULL_SERVICE = BRAKE_POSITIONS.indexOf('Full Service');
const BRAKE_SHORT = ['Rel', 'Run', 'Lap', 'S1', 'S2', 'S3', 'S4', 'S5', 'Full'];
const IDLE_MS = 4000;

/**
 * The landscape HUD and controls for phones and tablets. Info on the left
 * (signal / next limit / next station cards, timetable), the speedometer on the
 * bottom edge, the control bar bottom-left, horn, reverser and two cab levers
 * on the right. The middle of the screen stays clear for the track ahead.
 * Every control tracks its own pointer, so several can be used at once and none
 * of them moves the camera. The DOM is written only when a value changes.
 */
export class TouchControls {
  readonly el = h('div', 'touch-ui');
  private signal = new SignalCard();
  private limitCard = new SpeedLimitCard();
  private station = new StationCard();
  private timetable = new TimetableCard();
  private score = new ScoreBadge();
  private speedo = new Speedometer();
  private bar: ControlBar;
  private reverser: ReverserSwitch;
  private camPick: CameraPicker;
  private throttle: Lever;
  private brakeLever: Lever;
  private notchOut: HTMLElement;
  private levers: HTMLElement;
  private drawer: HTMLElement;
  private vig: HTMLElement;
  private shown = { vcb: false, flasher: false, loco: -1, vig: '', layout: '' };
  private lastTouch = performance.now();
  private hornDownAt = 0;
  private hornTimer = 0;
  private idleTimer = 0;
  private raf = 0;
  private offs: (() => void)[] = [];

  constructor(parent: HTMLElement, private hk: TouchHooks) {
    const s = hk.sys;
    // ---- top-left: pause + camera picker
    const tl = h('div', 'm-tl');
    const pause = h('button', 'm-pause', ICON.pause);
    pause.setAttribute('aria-label', 'Pause menu');
    pause.dataset.tid = 'pause';
    onTap(pause, () => hk.pause());
    this.camPick = new CameraPicker(i => hk.camera(i));
    tl.append(pause, this.camPick.el);

    // ---- left: info cards (tap any for the full gauges)
    const cards = h('div', 'm-cards');
    cards.append(this.signal.el, this.limitCard.el, this.station.el);
    this.signal.el.dataset.tid = 'signal';
    cards.addEventListener('click', e => { e.stopPropagation(); hk.toggleDetails(); });
    this.timetable.el.dataset.tid = 'timetable';

    // ---- bottom: control bar, speedometer, horn
    this.bar = new ControlBar((a, d) => hk.act(a, d), () => this.setDrawer(this.drawer.hidden === true), () => hk.act('pantograph', true));
    this.speedo.el.dataset.tid = 'speedo';
    const horn = h('button', 'm-horn', ICON.horn);
    horn.dataset.tid = 'horn';
    horn.setAttribute('aria-label', 'Horn (hold for a long blast)');
    this.hornButton(horn);

    // ---- right: score, reverser, notch readout, levers
    const right = h('div', 'm-right');
    this.reverser = new ReverserSwitch(r => hk.setReverser(r));
    this.notchOut = h('div', 'm-card m-notch', `<small>THROTTLE</small><b></b>`);
    this.throttle = new Lever('THROTTLE', 'throttle', true, hk.notches, v => s.setThrottle(v), v => String(v));
    this.brakeLever = new Lever('BRAKE', 'brake', false, FULL_SERVICE, v => s.setTrainBrake(v), v => BRAKE_SHORT[v] ?? 'EMG');
    this.levers = h('div', 'm-levers');
    this.levers.append(this.brakeLever.el, this.throttle.el);
    right.append(this.score.el, this.reverser.el, this.notchOut, this.levers);

    // ---- vigilance pop-up and the More drawer
    this.vig = h('button', 'm-vig', 'VIGILANCE<small>tap</small>');
    this.vig.dataset.tid = 'vigilance';
    this.vig.hidden = true;
    onTap(this.vig, () => hk.act('vigilance', true));
    this.drawer = h('div', 't-drawer', `
      <h3>More controls</h3>
      <div class="t-grid">
        <button data-act="vcb" data-tid="vcb">Main breaker<small data-v="vcb">open</small></button>
        <button data-hold="sander" data-tid="sander">Sander<small>hold</small></button>
        <button data-act="vigilance" data-tid="vigilanceBtn">Vigilance<small>acknowledge</small></button>
        <button data-act="flasher" data-tid="flasher">Flasher<small data-v="flasher">off</small></button>
      </div>
      <div class="t-row" data-tid="locoBrake"><span>Loco brake <small data-v="loco">0%</small></span><span class="t-seg"><button data-act="locoBrakeRelease">Release</button><button data-act="locoBrakeApply">Apply</button></span></div>
      <div class="t-grid">
        <button data-ui="free">Free camera</button>
        <button data-ui="details">All gauges</button>
        <button data-ui="map">Map</button>
      </div>`);
    this.drawer.hidden = true;
    this.drawer.addEventListener('click', e => {
      e.stopPropagation();
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      if (b.dataset.act) { hk.act(b.dataset.act as Action, true); hk.act(b.dataset.act as Action, false); }
      if (b.dataset.ui === 'free') { hk.camera(6); this.setDrawer(false); }
      if (b.dataset.ui === 'details') hk.toggleDetails();
      if (b.dataset.ui === 'map') hk.toggleMap();
    });
    const sander = this.drawer.querySelector<HTMLButtonElement>('[data-hold="sander"]')!;
    sander.addEventListener('pointerdown', e => { e.preventDefault(); sander.setPointerCapture(e.pointerId); hk.act('sander', true); });
    for (const ev of ['pointerup', 'pointercancel'] as const) sander.addEventListener(ev, () => hk.act('sander', false));

    // bottom-left: timetable card stacked on the bar (the bar wraps to two rows on narrow screens)
    const bl = h('div', 'm-bl');
    bl.append(this.timetable.el, this.bar.el);
    this.el.append(tl, cards, bl, this.speedo.el, horn, right, this.vig, this.drawer);
    parent.appendChild(this.el);

    // ---- pantograph: follow its travel every frame while it moves, toast start and finish
    this.bar.panto.onSettled = up => bus.emit('message', { text: up ? 'Pantograph up' : 'Pantograph down', kind: up ? 'good' : 'info', ms: 2000 });
    this.offs.push(
      bus.on('pantograph', e => {
        bus.emit('message', { text: e.up ? 'Raising pantograph…' : 'Lowering pantograph…', kind: 'info', ms: 2500 });
        this.followPanto();
      }),
      bus.on('needs-pantograph', () => this.nudge(this.bar.panto.el)),
    );

    addEventListener('pointerdown', this.onAnyPointer, true);
    this.idleTimer = window.setInterval(() => this.checkIdle(), 500);
  }

  private followPanto() {
    cancelAnimationFrame(this.raf);
    const step = () => {
      const s = this.hk.sys;
      this.bar.panto.update(s.pantoPos, s.pantoUp);
      if (s.pantoMoving) this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  /** Briefly pulse a control to point the player at it. */
  private nudge(e: HTMLElement) {
    e.classList.remove('nudge');
    void e.getBoundingClientRect();
    e.classList.add('nudge');
    buzz(30);
  }

  private onAnyPointer = (e: PointerEvent) => {
    this.lastTouch = performance.now();
    this.el.classList.remove('idle');
    const t = e.target as HTMLElement;
    if (!this.drawer.hidden && !t.closest('.t-drawer, .m-more')) this.setDrawer(false);
    if (this.camPick.isOpen && !t.closest('.m-campick')) this.camPick.open(false);
  };

  private checkIdle() {
    const idle = this.hk.autoHide() && performance.now() - this.lastTouch > IDLE_MS && this.drawer.hidden === true && !this.camPick.isOpen;
    this.el.classList.toggle('idle', idle);
  }

  private setDrawer(open: boolean) {
    this.drawer.hidden = !open;
    this.bar.setMoreOpen(open);
  }

  /** Tap = short blast (at least 0.35 s), hold = long. */
  private hornButton(b: HTMLElement) {
    b.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      b.setPointerCapture(e.pointerId);
      clearTimeout(this.hornTimer);
      this.hornDownAt = performance.now();
      this.hk.act('horn', true);
      b.classList.add('on');
    });
    const up = () => {
      if (!b.classList.contains('on')) return;
      const left = Math.max(0, 350 - (performance.now() - this.hornDownAt));
      this.hornTimer = window.setTimeout(() => { this.hk.act('horn', false); b.classList.remove('on'); }, left);
    };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
  }

  /** Pulse an on-screen control for the tutorial (and the More button if the control is in the drawer). */
  highlight(tid: string | null) {
    this.el.querySelectorAll('.tut-pulse').forEach(e => e.classList.remove('tut-pulse'));
    if (!tid) return;
    const t = this.el.querySelector<HTMLElement>(`[data-tid="${tid}"]`);
    if (!t) return;
    t.classList.add('tut-pulse');
    if (this.drawer.contains(t) && this.drawer.hidden) this.el.querySelector('.m-more')?.classList.add('tut-pulse');
  }

  /** Called by the game's HUD tick (10 Hz). */
  update(d: MobileHudData) {
    const s = this.hk.sys, b = this.hk.brake(), sh = this.shown;
    const layout = this.hk.leverLayout();
    if (layout !== sh.layout) {
      sh.layout = layout;
      const split = layout === 'split';
      this.el.classList.toggle('split', split);
      // split: throttle on the left edge for the left thumb; both: brake then throttle on the right
      if (split) this.el.append(this.throttle.el); else this.levers.append(this.throttle.el);
    }
    this.signal.update(d.signal);
    this.limitCard.update(d.restriction);
    this.station.update(d.station);
    this.timetable.update(d.timetable);
    this.score.update(d.score);
    this.speedo.update(d.speed, d.limit, d.maxKmph, d.units);
    this.bar.show(s);
    this.reverser.show(s.reverser);
    this.camPick.show(this.hk.cameraIndex());
    this.throttle.show(s.notch);
    this.brakeLever.show(Math.min(b.handle, FULL_SERVICE));
    this.brakeLever.el.classList.toggle('emergency', b.handle > FULL_SERVICE);
    setText(this.notchOut.querySelector('b')!, s.regen > 0 ? `Regen ${s.regen}` : s.notch === 0 ? 'Idle' : `Notch ${s.notch}`);
    const text = (k: string, v: string) => setText(this.drawer.querySelector(`[data-v="${k}"]`)!, v);
    if (s.vcb !== sh.vcb) { sh.vcb = s.vcb; text('vcb', s.vcb ? 'closed' : 'open'); this.drawer.querySelector('[data-act="vcb"]')!.classList.toggle('on', s.vcb); }
    if (s.flasher !== sh.flasher) { sh.flasher = s.flasher; text('flasher', s.flasher ? 'on' : 'off'); this.drawer.querySelector('[data-act="flasher"]')!.classList.toggle('on', s.flasher); }
    const loco = Math.round(b.independent * 100);
    if (loco !== sh.loco) { sh.loco = loco; text('loco', `${loco}%`); }
    if (d.vigilance !== sh.vig) {
      sh.vig = d.vigilance;
      this.vig.hidden = d.vigilance === 'ok';
      this.vig.firstChild!.textContent = d.vigilance === 'penalty' ? 'PENALTY - STOP' : 'VIGILANCE';
      if (!this.vig.hidden) buzz(40);
    }
  }

  /** God Mode "hide HUD": only the pause button stays (there is no Esc key on a phone). */
  setBare(bare: boolean) { this.el.classList.toggle('bare', bare); }

  dispose() {
    for (const o of this.offs) o();
    removeEventListener('pointerdown', this.onAnyPointer, true);
    clearInterval(this.idleTimer);
    clearTimeout(this.hornTimer);
    cancelAnimationFrame(this.raf);
    this.el.remove();
  }
}
