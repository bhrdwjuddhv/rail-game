import { BRAKE_POSITIONS } from '@rail/shared/physics/BrakeSystem';
import type { LocoSystems } from '@rail/shared/train/LocoSystems';
import type { Action } from '../core/Settings';
import { buzz } from '../input/Device';

/** What the touch layer needs from the game. */
export interface TouchHooks {
  sys: LocoSystems;
  notches: number;
  /** train brake handle position (index into BRAKE_POSITIONS) and loco brake 0..1 */
  brake(): { handle: number; independent: number };
  /** same as a key press / release */
  act(a: Action, down: boolean): void;
  setReverser(r: -1 | 0 | 1): void;
  /** select camera by index (0 cab, 1 front, 3 side, 4 chase, 6 free) */
  camera(i: number): void;
  cameraIndex(): number;
  /** show/hide the full HUD detail card and the minimap */
  toggleDetails(): void;
  toggleMap(): void;
  autoHide(): boolean;
}

export interface StripData { speed: number; units: string; limit: number; aspect: string | null; dist: number | null; vigilance: 'ok' | 'warning' | 'penalty' }

const FULL_SERVICE = BRAKE_POSITIONS.indexOf('Full Service');
const BRAKE_SHORT = ['Rel', 'Run', 'Lap', 'S1', 'S2', 'S3', 'S4', 'S5', 'Full'];
/** touch camera cycle: Cab -> Front -> Chase -> Trackside */
const CAMERA_CYCLE = [0, 1, 4, 3];
const IDLE_MS = 4000;

/**
 * On-screen controls for touch devices, kept to the screen edges so the track
 * ahead stays clear: throttle slider (left thumb), train brake slider with a
 * long-press emergency button and the horn (right thumb), a compact info strip
 * at the top, and a "More" drawer for everything else. Every control tracks its
 * own pointer, so both thumbs work at once and the sliders never move the camera.
 */
export class TouchControls {
  readonly el = document.createElement('div');
  private q = <T extends HTMLElement>(s: string) => this.el.querySelector<T>(s)!;
  private lastTouch = performance.now();
  private shown = { notch: -1, brake: -1, rev: 9, panto: false, vcb: false, head: -1, wipers: -1, loco: -1, vig: '' };
  private drawer: HTMLElement;
  private hornDownAt = 0;
  private hornTimer = 0;
  private emergTimer = 0;
  private idleTimer = 0;

  constructor(parent: HTMLElement, private h: TouchHooks) {
    this.el.className = 'touch-ui';
    this.el.innerHTML = `
      <button class="t-strip" data-tid="strip" aria-label="Speed, limit and next signal. Tap for details">
        <span class="t-speed">0</span><small class="t-units">km/h</small>
        <span class="t-limit">--</span>
        <span class="t-sig"><i class="lamp"></i><span>--</span></span>
      </button>
      <div class="t-slider t-throttle" data-tid="throttle" role="slider" aria-label="Throttle" aria-valuemin="0" aria-valuemax="${h.notches}">
        <div class="t-track"><div class="t-fill"></div><div class="t-knob"><span>0</span></div></div><label>POWER</label>
      </div>
      <div class="t-slider t-brake" data-tid="brake" role="slider" aria-label="Train brake" aria-valuemin="0" aria-valuemax="${FULL_SERVICE}">
        <div class="t-track"><div class="t-fill"></div><div class="t-knob"><span>Rel</span></div></div><label>BRAKE</label>
      </div>
      <button class="t-emerg" data-tid="emergency" aria-label="Emergency brake (hold)"><b>EMERG</b><small>hold</small></button>
      <button class="t-horn" data-tid="horn" aria-label="Horn">&#128227;</button>
      <button class="t-cam" data-tid="camera" aria-label="Next camera"><svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M4 7h3l1.5-2h7L17 7h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zm8 3a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z"/></svg></button>
      <button class="t-more" data-tid="more" aria-label="More controls">&#8943;</button>
      <button class="t-vig" data-tid="vigilance" hidden>VIGILANCE<small>tap</small></button>
      <div class="t-drawer" hidden>
        <h3>Controls</h3>
        <div class="t-row"><span>Reverser</span><span class="t-seg" data-tid="reverser"><button data-rev="1">F</button><button data-rev="0">N</button><button data-rev="-1">R</button></span></div>
        <div class="t-grid">
          <button data-act="pantograph" data-tid="panto">Pantograph<small data-v="panto">down</small></button>
          <button data-act="vcb" data-tid="vcb">Main breaker<small data-v="vcb">open</small></button>
          <button data-act="headlights" data-tid="headlight">Headlight<small data-v="head">off</small></button>
          <button data-act="wipers" data-tid="wipers">Wipers<small data-v="wipers">off</small></button>
          <button data-hold="sander" data-tid="sander">Sander<small>hold</small></button>
          <button data-act="vigilance" data-tid="vigilanceBtn">Vigilance<small>acknowledge</small></button>
        </div>
        <div class="t-row" data-tid="locoBrake"><span>Loco brake <small data-v="loco">0%</small></span><span class="t-seg"><button data-act="locoBrakeRelease">Release</button><button data-act="locoBrakeApply">Apply</button></span></div>
        <div class="t-grid">
          <button data-ui="free">Free camera</button>
          <button data-ui="details">HUD details</button>
          <button data-ui="map">Map</button>
        </div>
      </div>`;
    parent.appendChild(this.el);
    this.drawer = this.q('.t-drawer');

    this.slider(this.q('.t-throttle'), true, h.notches, v => { if (v !== h.sys.notch) { h.sys.setThrottle(v); buzz(); } });
    this.slider(this.q('.t-brake'), false, FULL_SERVICE, v => { if (v !== h.brake().handle) { h.sys.setTrainBrake(v); buzz(); } });
    this.emergency(this.q('.t-emerg'));
    this.horn(this.q('.t-horn'));

    const tap = (sel: string, fn: () => void) => this.q(sel).addEventListener('click', e => { e.stopPropagation(); fn(); });
    tap('.t-cam', () => {
      const i = CAMERA_CYCLE.indexOf(h.cameraIndex());
      h.camera(CAMERA_CYCLE[(i + 1) % CAMERA_CYCLE.length]);
    });
    tap('.t-more', () => this.setDrawer(this.drawer.hidden === true));
    tap('.t-strip', () => h.toggleDetails());
    tap('.t-vig', () => h.act('vigilance', true));
    this.drawer.addEventListener('click', e => {
      e.stopPropagation();
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      if (b.dataset.rev !== undefined) h.setReverser(Number(b.dataset.rev) as -1 | 0 | 1);
      if (b.dataset.act) { h.act(b.dataset.act as Action, true); h.act(b.dataset.act as Action, false); }
      if (b.dataset.ui === 'free') { h.camera(6); this.setDrawer(false); }
      if (b.dataset.ui === 'details') h.toggleDetails();
      if (b.dataset.ui === 'map') h.toggleMap();
    });
    const sander = this.q<HTMLButtonElement>('[data-hold="sander"]');
    sander.addEventListener('pointerdown', e => { e.preventDefault(); sander.setPointerCapture(e.pointerId); h.act('sander', true); });
    for (const ev of ['pointerup', 'pointercancel'] as const) sander.addEventListener(ev, () => h.act('sander', false));
    // tap outside the drawer closes it
    addEventListener('pointerdown', this.onAnyPointer, true);
    this.idleTimer = window.setInterval(() => this.checkIdle(), 500);
  }

  private onAnyPointer = (e: PointerEvent) => {
    this.lastTouch = performance.now();
    this.el.classList.remove('idle');
    if (!this.drawer.hidden && !(e.target as HTMLElement).closest('.t-drawer, .t-more')) this.setDrawer(false);
  };

  private checkIdle() {
    const idle = this.h.autoHide() && performance.now() - this.lastTouch > IDLE_MS && this.drawer.hidden === true;
    this.el.classList.toggle('idle', idle);
  }

  private setDrawer(open: boolean) {
    this.drawer.hidden = !open;
    this.q('.t-more').classList.toggle('on', open);
  }

  /**
   * Vertical notched slider. `upIsMore`: throttle grows upward; the brake
   * releases at the top and applies as it is pulled down.
   */
  private slider(el: HTMLElement, upIsMore: boolean, max: number, set: (v: number) => void) {
    const track = el.querySelector<HTMLElement>('.t-track')!;
    let id = -1;
    const at = (y: number) => {
      const r = track.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (y - r.top) / r.height));
      return Math.round((upIsMore ? 1 - f : f) * max);
    };
    el.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      id = e.pointerId;
      el.setPointerCapture(id);
      el.classList.add('active');
      set(at(e.clientY));
    });
    el.addEventListener('pointermove', e => { if (e.pointerId === id) { e.preventDefault(); set(at(e.clientY)); } });
    const end = (e: PointerEvent) => { if (e.pointerId === id) { id = -1; el.classList.remove('active'); } };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  /** Emergency needs a 0.5 s hold so a stray touch cannot dump the brakes. */
  private emergency(b: HTMLElement) {
    b.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      b.setPointerCapture(e.pointerId);
      b.classList.add('arming');
      clearTimeout(this.emergTimer);
      this.emergTimer = window.setTimeout(() => {
        b.classList.remove('arming');
        this.h.act('emergency', true);
        buzz(80);
      }, 500);
    });
    const cancel = () => { clearTimeout(this.emergTimer); b.classList.remove('arming'); };
    b.addEventListener('pointerup', cancel);
    b.addEventListener('pointercancel', cancel);
  }

  /** Tap = short blast (at least 0.35 s), hold = long. */
  private horn(b: HTMLElement) {
    b.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      b.setPointerCapture(e.pointerId);
      clearTimeout(this.hornTimer);
      this.hornDownAt = performance.now();
      this.h.act('horn', true);
      b.classList.add('on');
    });
    const up = () => {
      if (!b.classList.contains('on')) return;
      const left = Math.max(0, 350 - (performance.now() - this.hornDownAt));
      this.hornTimer = window.setTimeout(() => { this.h.act('horn', false); b.classList.remove('on'); }, left);
    };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
  }

  /** Pulse an on-screen control for the tutorial (opens the drawer if the control is in it). */
  highlight(tid: string | null) {
    this.el.querySelectorAll('.tut-pulse').forEach(e => e.classList.remove('tut-pulse'));
    if (!tid) return;
    const t = this.el.querySelector<HTMLElement>(`[data-tid="${tid}"]`);
    if (!t) return;
    t.classList.add('tut-pulse');
    if (this.drawer.contains(t) && this.drawer.hidden) this.q('.t-more').classList.add('tut-pulse');
  }

  /** Keep the controls in step with the train (keyboard, auto-drive or tutorial can move them too). */
  update(d: StripData) {
    const s = this.h.sys, b = this.h.brake(), sh = this.shown;
    this.q('.t-speed').textContent = String(Math.round(d.speed));
    this.q('.t-units').textContent = d.units;
    const lim = this.q('.t-limit');
    lim.textContent = String(d.limit);
    lim.classList.toggle('over', d.speed > d.limit + 2);
    const sig = this.q('.t-sig');
    sig.querySelector('i')!.className = `lamp ${d.aspect === 'R' ? 'r' : d.aspect === 'G' ? 'g' : d.aspect ? 'y' : ''}`;
    sig.querySelector('span')!.textContent = d.dist === null ? '--' : d.dist >= 1000 ? `${(d.dist / 1000).toFixed(1)} km` : `${Math.max(0, Math.round(d.dist))} m`;

    if (s.notch !== sh.notch) {
      sh.notch = s.notch;
      this.setSlider(this.q('.t-throttle'), s.notch / this.h.notches, true, String(s.notch));
    }
    const handle = Math.min(b.handle, FULL_SERVICE);
    if (b.handle !== sh.brake) {
      sh.brake = b.handle;
      this.setSlider(this.q('.t-brake'), handle / FULL_SERVICE, false, b.handle > FULL_SERVICE ? 'EMG' : BRAKE_SHORT[handle]);
    }
    if (s.reverser !== sh.rev) {
      sh.rev = s.reverser;
      this.el.querySelectorAll<HTMLElement>('[data-rev]').forEach(x => x.classList.toggle('on', Number(x.dataset.rev) === s.reverser));
    }
    const text = (k: string, v: string) => { this.q(`[data-v="${k}"]`).textContent = v; };
    if (s.pantoUp !== sh.panto) { sh.panto = s.pantoUp; text('panto', s.pantoUp ? 'up' : 'down'); this.q('[data-act="pantograph"]').classList.toggle('on', s.pantoUp); }
    if (s.vcb !== sh.vcb) { sh.vcb = s.vcb; text('vcb', s.vcb ? 'closed' : 'open'); this.q('[data-act="vcb"]').classList.toggle('on', s.vcb); }
    if (s.headlight !== sh.head) { sh.head = s.headlight; text('head', ['off', 'dim', 'bright'][s.headlight]); this.q('[data-act="headlights"]').classList.toggle('on', s.headlight > 0); }
    if (s.wipers !== sh.wipers) { sh.wipers = s.wipers; text('wipers', ['off', 'slow', 'fast'][s.wipers]); this.q('[data-act="wipers"]').classList.toggle('on', s.wipers > 0); }
    const loco = Math.round(b.independent * 100);
    if (loco !== sh.loco) { sh.loco = loco; text('loco', `${loco}%`); }
    if (d.vigilance !== sh.vig) {
      sh.vig = d.vigilance;
      const v = this.q('.t-vig');
      v.hidden = d.vigilance === 'ok';
      v.firstChild!.textContent = d.vigilance === 'penalty' ? 'PENALTY - STOP' : 'VIGILANCE';
      if (!v.hidden) buzz(40);
    }
  }

  private setSlider(el: HTMLElement, f: number, upIsMore: boolean, label: string) {
    const p = Math.round(f * 1000) / 10;
    const fill = el.querySelector<HTMLElement>('.t-fill')!, knob = el.querySelector<HTMLElement>('.t-knob')!;
    if (upIsMore) { fill.style.height = `${p}%`; knob.style.bottom = `${p}%`; knob.style.top = ''; }
    else { fill.style.height = `${p}%`; knob.style.top = `${p}%`; knob.style.bottom = ''; }
    knob.querySelector('span')!.textContent = label;
    el.setAttribute('aria-valuenow', label);
  }

  dispose() {
    removeEventListener('pointerdown', this.onAnyPointer, true);
    clearInterval(this.idleTimer);
    clearTimeout(this.hornTimer);
    clearTimeout(this.emergTimer);
    this.el.remove();
  }
}
