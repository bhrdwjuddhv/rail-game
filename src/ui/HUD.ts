import { bus } from '../core/EventBus';

export interface HudData {
  speed: number; units: string; limit: number; notch: string; reverser: string;
  bp: number; bc: number; mr: number;
  signal: { id: string; aspect: string; dist: number } | null;
  station: { name: string; dist: number; stop: boolean } | null;
  restriction: { kmph: number; dist: number } | null;
  clock: string; eta: string; due: string; gradient: string; km: number; score: number | null;
  vigilance: 'ok' | 'warning' | 'penalty'; camera: string; weather: string;
}

const ASPECT_HTML: Record<string, string> = {
  R: '<i class="lamp r"></i>', Y: '<i class="lamp y"></i>', YY: '<i class="lamp y"></i><i class="lamp y"></i>', G: '<i class="lamp g"></i>',
};

/** Clean HTML overlay; toggled with H. Messages stack top-left. */
export class HUD {
  readonly root: HTMLElement;
  private panel: HTMLElement;
  private msgs: HTMLElement;
  private tip: HTMLElement;
  private vig: HTMLElement;
  private els: Record<string, HTMLElement> = {};
  visible = true;
  private godBadge: HTMLElement;
  setGodMode(on: boolean) { this.godBadge.hidden = !on; }
  /** Hide everything (God Mode "hide HUD" for screenshots); the pause button stays reachable via Esc. */
  setHidden(hidden: boolean) { this.root.style.display = hidden ? 'none' : ''; }
  private offs: (() => void)[] = [];

  constructor(parent: HTMLElement, onPause: () => void) {
    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.root.innerHTML = `
      <button class="pause-btn" title="Menu (Esc)" aria-label="Open menu"><span aria-hidden="true">&#10074;&#10074;</span> Menu</button>
      <div class="god-badge" hidden>GOD MODE</div>
      <div class="hud-panel">
        <div class="row big"><span data-k="speed">0</span><small data-k="units">km/h</small><span class="limit" data-k="limit">--</span></div>
        <div class="row"><b>Notch</b><span data-k="notch">0</span><b>Rev</b><span data-k="rev">N</span></div>
        <div class="row"><b>BP</b><span data-k="bp">5.0</span><b>BC</b><span data-k="bc">0.0</span><b>MR</b><span data-k="mr">9.0</span></div>
        <div class="row"><b>Signal</b><span data-k="signal">-</span></div>
        <div class="row"><b>Station</b><span data-k="station">-</span></div>
        <div class="row"><b>Next limit</b><span data-k="restriction">-</span></div>
        <div class="row"><b>Grade</b><span data-k="grade">Level</span><b>km</b><span data-k="km">0</span></div>
        <div class="row"><b>Time</b><span data-k="clock">--</span><b>ETA</b><span data-k="eta">--</span></div>
        <div class="row dim"><span data-k="due"></span></div>
        <div class="row dim"><span data-k="cam"></span><span data-k="score"></span></div>
      </div>
      <div class="hud-msgs"></div>
      <div class="hud-tip"></div>
      <div class="hud-vig">VIGILANCE - PRESS Q</div>`;
    parent.appendChild(this.root);
    this.panel = this.root.querySelector('.hud-panel')!;
    this.msgs = this.root.querySelector('.hud-msgs')!;
    this.tip = this.root.querySelector('.hud-tip')!;
    this.vig = this.root.querySelector('.hud-vig')!;
    this.root.querySelectorAll<HTMLElement>('[data-k]').forEach(e => (this.els[e.dataset.k!] = e));
    this.offs.push(bus.on('message', m => this.message(m.text, m.kind ?? 'info', m.ms ?? 3500)));
    const btn = this.root.querySelector<HTMLButtonElement>('.pause-btn')!;
    btn.addEventListener('click', () => { btn.blur(); onPause(); });
    this.godBadge = this.root.querySelector<HTMLElement>('.god-badge')!;
  }

  toggle() { this.visible = !this.visible; this.panel.style.display = this.visible ? '' : 'none'; }

  message(text: string, kind: string, ms: number) {
    const d = document.createElement('div');
    d.className = `msg ${kind}`;
    d.textContent = text;
    this.msgs.appendChild(d);
    while (this.msgs.children.length > 6) this.msgs.firstElementChild!.remove();
    setTimeout(() => { d.classList.add('fade'); setTimeout(() => d.remove(), 600); }, ms);
  }

  setTip(text: string | null) { this.tip.textContent = text ?? ''; this.tip.style.opacity = text ? '1' : '0'; }

  update(d: HudData) {
    const e = this.els;
    e.speed.textContent = String(Math.round(d.speed));
    e.units.textContent = d.units;
    e.limit.textContent = String(d.limit);
    e.limit.classList.toggle('over', d.speed > d.limit + 2);
    e.notch.textContent = d.notch;
    e.rev.textContent = d.reverser;
    e.bp.textContent = d.bp.toFixed(1); e.bc.textContent = d.bc.toFixed(1); e.mr.textContent = d.mr.toFixed(1);
    e.signal.innerHTML = d.signal ? `${ASPECT_HTML[d.signal.aspect] ?? ''} ${d.signal.id} &middot; ${fmtDist(d.signal.dist)}` : '—';
    e.station.textContent = d.station ? `${d.station.name} ${fmtDist(d.station.dist)}${d.station.stop ? ' (stop)' : ''}` : '—';
    e.restriction.textContent = d.restriction ? `${d.restriction.kmph} in ${fmtDist(d.restriction.dist)}` : '—';
    e.grade.textContent = d.gradient;
    e.km.textContent = d.km.toFixed(2);
    e.clock.textContent = d.clock;
    e.eta.textContent = d.eta === '--' ? '—' : d.eta;
    e.due.textContent = d.due;
    e.cam.textContent = `${d.camera} · ${d.weather}`;
    e.score.textContent = d.score === null ? '' : ` · Score ${d.score}`;
    this.vig.style.display = d.vigilance === 'ok' ? 'none' : 'block';
    this.vig.textContent = d.vigilance === 'penalty' ? 'PENALTY BRAKE - STOP, THEN PRESS Q' : 'VIGILANCE - PRESS Q';
  }

  dispose() { for (const o of this.offs) o(); this.root.remove(); }
}

export const fmtDist = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.max(0, Math.round(m))} m`);
