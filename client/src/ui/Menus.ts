import { loadSave } from '../core/Settings';
import { COACHES, LOCOS, ROUTES, SCENARIOS } from '../data';
import { WEATHER, WeatherId } from '../environment/Weather';
import type { ScenarioOverrides } from '@rail/shared/gameplay/Scenario';
import { CATEGORY_NAMES, Category, ScoreEntry } from '@rail/shared/gameplay/Scoring';
import { formatClock } from '@rail/shared/util';
import { settingsPanel } from './Settings';
import { assets } from '../core/AssetRegistry';
import { isTouch } from '../input/Device';

export interface PauseCallbacks {
  title: string; godActive: boolean;
  resume(): void; tutorial(): void; godMode(): void; restart(): void; quit(): void;
}

export interface MenuCallbacks {
  start(scenarioId: string, o: ScenarioOverrides, opts?: { tutorial?: boolean }): void;
  captureKey(cb: (code: string) => void): void;
}

/** Help on phones and tablets: the on-screen controls instead of keys. */
const TOUCH_HELP_HTML = `
<h2>Driving Rail Bharat</h2>
<div class="cols help">
<section><h3>Getting moving</h3>
<ol><li>Tap the <b>pantograph</b> button in the bottom bar and wait for its LED to turn green</li>
<li>Tap <b>&#8943;</b> and close the <b>Main breaker</b>, then <b>Release</b> the loco brake</li>
<li>Tap <b>F</b> on the <b>REVERSER</b> switch (top right)</li>
<li>Push the <b>BRAKE</b> lever up to <b>Run</b>; wait for a yellow or green signal (top-left card)</li>
<li>Push the <b>THROTTLE</b> lever up a few notches</li></ol>
<h3>On screen</h3><table>
<tr><td>Levers (right)</td><td>BRAKE: Rel at the top to Full at the bottom. THROTTLE: notches, each one clicks. Settings &rarr; Lever layout can put the throttle on the left edge</td></tr>
<tr><td>Bottom bar</td><td>EMERGENCY STOP (hold half a second), wipers, pantograph, headlight, cab light, marker lights, &#8943; More</td></tr>
<tr><td>LEDs</td><td>Green on, grey off, blinking amber while changing</td></tr>
<tr><td>Horn (blue)</td><td>Tap for a short blast, hold for a long one</td></tr>
<tr><td>Left cards</td><td>Next signal, next speed limit, next station. Tap them for all the gauges</td></tr>
<tr><td>&#8943; More</td><td>Main breaker, sander, vigilance, flasher, loco brake, free camera, all gauges, map</td></tr>
<tr><td>VIGILANCE</td><td>Pops up when the vigilance alarm sounds: tap it</td></tr></table></section>
<section><h3>View</h3><table>
<tr><td>One finger</td><td>Drag to look around (cab) or orbit (chase)</td></tr><tr><td>Two fingers</td><td>Pinch to zoom</td></tr>
<tr><td>Camera (top left)</td><td>Pick Cab, Front, Rear, Side, Chase, Cinematic or Free</td></tr><tr><td>Pause (top left)</td><td>Menu, settings, God Mode, tutorial</td></tr></table>
<h3>Signals</h3><p><span class="lamp g"></span> Green: proceed &nbsp; <span class="lamp y"></span><span class="lamp y"></span> Double yellow: next signal at caution
&nbsp; <span class="lamp y"></span> Yellow: be ready to stop at the next signal &nbsp; <span class="lamp r"></span> Red: stop. Passing red = SPAD.</p>
<p>Sound the horn at W/L boards before level crossings. Stop with the head at the marker for your train length (8/12/16/20/24).
Buttons and cards fade when you are not touching the screen; any touch brings them back (Settings can turn this off).</p></section>
</div>`;

const html = (s: string) => { const d = document.createElement('div'); d.innerHTML = s.trim(); return d.firstElementChild as HTMLElement; };
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export const HELP_HTML = `
<h2>Driving Rail Bharat</h2>
<div class="cols help">
<section><h3>Getting moving</h3>
<ol><li><b>P</b> raise pantograph, wait for the PANTO lamp to go out</li><li><b>O</b> close the main breaker (VCB)</li>
<li><b>;</b> release the train brake (watch BP rise to 5.0)</li><li><b>W</b> reverser to forward</li>
<li>Wait for the starter signal, then <b>D</b> to notch up</li></ol>
<h3>Train controls</h3><table>
<tr><td>A / D</td><td>Throttle notch down / up</td></tr><tr><td>Z / C</td><td>Regenerative brake down / up</td></tr>
<tr><td>; / '</td><td>Train (air) brake release / apply</td></tr><tr><td>[ / ]</td><td>Loco brake release / apply</td></tr>
<tr><td>Backspace</td><td>Emergency brake</td></tr><tr><td>W / S</td><td>Reverser forward / back</td></tr>
<tr><td>Space / Shift+Space</td><td>Horn low / high</td></tr><tr><td>Q</td><td>Vigilance acknowledge (every 60 s)</td></tr>
<tr><td>X (hold)</td><td>Sander</td></tr><tr><td>L</td><td>Headlight off / dim / bright</td></tr>
<tr><td>V</td><td>Wipers off / slow / fast</td></tr><tr><td>K / N / B</td><td>Cab light / markers / flasher</td></tr>
<tr><td>P / O</td><td>Pantograph / main breaker</td></tr></table></section>
<section><h3>Cameras &amp; view</h3><table>
<tr><td>1</td><td>Driver's cab (drag to look, wheel zoom, 1 again = reset)</td></tr><tr><td>2</td><td>Front of loco</td></tr>
<tr><td>3</td><td>Rear view (3 again = other side)</td></tr><tr><td>4</td><td>Side view (4 again = swap side, , . = vehicle)</td></tr>
<tr><td>5</td><td>Chase (drag orbit, wheel zoom)</td></tr><tr><td>6</td><td>Cinematic trackside</td></tr><tr><td>7</td><td>Free camera (WASD, R/F, Shift)</td></tr>
<tr><td>H / M</td><td>HUD / map</td></tr><tr><td>F3</td><td>Performance overlay</td></tr><tr><td>F1</td><td>This help</td></tr><tr><td>Esc</td><td>Pause</td></tr></table>
<h3>Signals</h3><p><span class="lamp g"></span> Green: proceed &nbsp; <span class="lamp y"></span><span class="lamp y"></span> Double yellow: next signal at caution
&nbsp; <span class="lamp y"></span> Yellow: be ready to stop at the next signal &nbsp; <span class="lamp r"></span> Red: stop. Passing red = SPAD.</p>
<p>Distant signals (P plate) never show red. Calling-on (small white lamp) lets you pass a red home signal at 15 km/h.
Sound the horn at W/L boards before level crossings. Stop with the head at the marker for your train length (8/12/16/20/24).</p>
<h3>Mouse in the cab</h3><p>Click a lever or switch to move it (right-click to move it back). Hold the horn buttons. Wheel over a lever adjusts it.</p>
<h3>Gamepad</h3><p>RT throttle, LT train brake, A horn, B sander, X vigilance, Y headlight, LB/RB loco brake, D-pad reverser, right stick look.</p></section>
</div>`;

/** Main menu, scenario select, free-roam setup with consist builder, pause, report, help, loading. */
export class Menus {
  readonly root: HTMLElement;
  private current: HTMLElement | null = null;

  constructor(parent: HTMLElement, private cb: MenuCallbacks) {
    this.root = document.createElement('div');
    this.root.id = 'menus';
    parent.appendChild(this.root);
    addEventListener('keydown', this.onKey);
    // full-screen artwork behind out-of-game screens (Ken Burns zoom); CSS gradient until/unless it loads
    this.bg.className = 'menu-bg';
    this.bg.innerHTML = '<div class="img"></div>';
    this.root.prepend(this.bg);
    const img = this.bg.firstElementChild as HTMLElement;
    const setImg = () => {
      const url = this.bgMode ? this.images[this.bgMode] : null;
      img.style.backgroundImage = url ? `url("${url}")` : '';
      img.classList.toggle('ready', !!url);
    };
    assets.uiImage('mainMenuBg').then(u => { this.images.main = u; setImg(); });
    assets.uiImage('loadingBg').then(u => { this.images.loading = u; setImg(); });
    assets.uiImage('logo').then(u => { this.logo = u; if (u) this.root.querySelectorAll<HTMLElement>('.title').forEach(t => this.applyLogo(t)); });
    this.refreshBg = setImg;
  }

  /** Set by the game once a run starts: in-game menus show the (blurred) game, not the artwork. */
  inGame = false;
  private bg = document.createElement('div');
  private bgMode: 'main' | 'loading' | null = null;
  private images: { main: string | null; loading: string | null } = { main: null, loading: null };
  private logo: string | null = null;
  private refreshBg: () => void;

  /** Swap a text title for the logo image (the text stays for screen readers). */
  private applyLogo(title: HTMLElement) {
    if (!this.logo || title.querySelector('img.logo')) return;
    const img = document.createElement('img');
    img.className = 'logo';
    img.src = this.logo;
    img.alt = '';
    title.prepend(img);
    title.classList.add('with-logo');
  }

  private back: (() => void) | null = null;

  private show(el: HTMLElement | null, back: (() => void) | null = null) {
    this.current?.remove();
    this.current = el;
    this.back = back;
    this.bgMode = !el || this.inGame ? null : el.classList.contains('loading') ? 'loading' : 'main';
    this.root.classList.toggle('has-bg', !!this.bgMode);
    this.bg.dataset.mode = this.bgMode ?? '';
    this.refreshBg?.();
    el?.querySelectorAll<HTMLElement>('.title').forEach(t => this.applyLogo(t));
    if (el) {
      this.root.appendChild(el);
      // keyboard users land on the first button
      requestAnimationFrame(() => el.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true }));
    }
    this.root.style.display = el ? '' : 'none';
  }
  hide() { this.show(null); }
  get open() { return !!this.current; }

  main() {
    const el = html(`<div class="menu main">
      <div class="title"><h1>Rail Bharat</h1><p>Indian broad-gauge electric locomotive simulator</p></div>
      <div class="buttons vertical">
        <button data-a="scenarios">Scenarios</button><button data-a="free">Free roam</button>
        <button data-a="tutorial">Tutorial: how to start the train</button>
        <button data-a="tutorial-diesel">Tutorial: start a diesel loco</button>
        <button data-a="online" class="soon" aria-disabled="true" title="Multiplayer is on its way">Play Online <small>Coming soon</small></button>
        <button data-a="settings">Settings</button><button data-a="help">Controls &amp; help</button>
      </div>
      <p class="note">Fictional operator, stations and liveries. Everything is generated in the browser.</p></div>`);
    el.addEventListener('click', e => {
      const a = (e.target as HTMLElement).closest('button')?.dataset.a;
      if (a === 'scenarios') this.scenarios();
      if (a === 'free') this.freeRoam();
      if (a === 'tutorial') this.cb.start('free-roam', { startStation: 'SNGH', time: '09:00', weather: 'clear' }, { tutorial: true });
      if (a === 'settings') this.show(settingsPanel(() => this.main(), this.cb.captureKey), () => this.main());
      if (a === 'help') this.help(() => this.main());
      if (a === 'tutorial-diesel') this.cb.start('free-roam', { startStation: 'SNGH', time: '09:00', weather: 'clear', loco: 'wdm-3d' }, { tutorial: true });
      if (a === 'online') {
        const b = el.querySelector<HTMLElement>('[data-a="online"] small')!;
        b.textContent = 'Coming soon - drive with friends on the same line';
        setTimeout(() => { b.textContent = 'Coming soon'; }, 2600);
      }
    });
    this.show(el);
  }

  scenarios() {
    const best = loadSave().best;
    const list = Object.values(SCENARIOS).filter(s => s.id !== 'free-roam');
    const el = html(`<div class="menu scen"><h2>Scenarios</h2>
      <h3>Locomotive</h3>${locoPicker('', true)}
      <div class="cards">${list.map(s => `
      <div class="card"><h3>${esc(s.name)} <small>${esc(s.difficulty)}</small></h3><p>${esc(s.description)}</p>
      <p class="meta">${esc(ROUTES[s.route]?.name ?? s.route)} &middot; ${s.time} &middot; ${WEATHER[s.weather].name} &middot; ${s.consist.coaches.reduce((a, c) => a + c.count, 0)} coaches
      ${best[s.id] ? `&middot; Best: <b>${best[s.id].score} (${best[s.id].grade})</b>` : ''}</p>
      <button data-id="${s.id}">Drive</button></div>`).join('')}</div>
      <div class="buttons"><button data-a="back">Back</button></div></div>`);
    el.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      if (pickLoco(el, b)) return;
      if (b.dataset.a === 'back') this.main();
      if (b.dataset.id) {
        const loco = (el.querySelector('[data-f="loco"]') as HTMLInputElement).value;
        this.cb.start(b.dataset.id, loco ? { loco } : {});
      }
    });
    this.show(el);
  }

  freeRoam() {
    const fr = SCENARIOS['free-roam'];
    const route = ROUTES[fr.route];
    const counts: Record<string, number> = {};
    for (const c of Object.values(COACHES)) if (c.windows !== 'none') counts[c.id] = fr.consist.coaches.find(x => x.type === c.id)?.count ?? 0;
    const el = html(`<div class="menu free"><h2>Free roam</h2>
      <div class="cols"><section><h3>Start</h3>
        <label>Station <select data-f="station">${route.stations.map(s => `<option value="${s.code}">${esc(s.name)} (${s.code}, km ${s.km})</option>`).join('')}</select></label>
        ${route.lines && route.lines.length > 1 ? `<label>Line <select data-f="track"><option value="DOWN">Down line (towards ${esc(route.stations[route.stations.length - 1].name)})</option><option value="UP">Up line (towards ${esc(route.stations[0].name)})</option></select></label>` : ''}
        <label>Time <input type="time" value="${fr.time}" data-f="time"></label>
        <label>Weather <select data-f="weather">${(Object.keys(WEATHER) as WeatherId[]).map(w => `<option value="${w}">${WEATHER[w].name}</option>`).join('')}</select></label>
      </section><section class="wide"><h3>Locomotive</h3>${locoPicker(fr.consist.loco, false)}
      </section><section><h3>Consist builder</h3>
        ${Object.keys(counts).map(id => `<label>${esc(COACHES[id].name)} <input type="number" min="0" max="24" value="${counts[id]}" data-c="${id}"></label>`).join('')}
        <label>Loaded <input type="checkbox" checked data-f="loaded"></label>
        <p class="note" data-f="summary"></p>
      </section></div>
      <div class="buttons"><button data-a="back">Back</button><button data-a="go">Start</button></div></div>`);
    const summary = el.querySelector<HTMLElement>('[data-f="summary"]')!;
    const read = () => {
      const coaches = Object.keys(counts).map(id => ({ type: id, count: Math.max(0, Math.min(24, Number(el.querySelector<HTMLInputElement>(`[data-c="${id}"]`)!.value) || 0)) })).filter(c => c.count > 0);
      const n = coaches.reduce((a, c) => a + c.count, 0);
      const loaded = el.querySelector<HTMLInputElement>('[data-f="loaded"]')!.checked;
      const mass = (LOCOS[(el.querySelector('[data-f="loco"]') as HTMLInputElement).value]?.massT ?? 0) + coaches.reduce((a, c) => a + c.count * (loaded ? COACHES[c.type].massLoadedT : COACHES[c.type].massEmptyT), 0);
      summary.textContent = `${n} coaches, ${Math.round(mass)} t, ${Math.round(20.56 + n * 24.1)} m long${n > 24 ? ' - too long for platforms (max 24)' : ''}`;
      return { coaches, loaded, n };
    };
    read();
    el.addEventListener('input', read);
    el.addEventListener('click', e => {
      const btn = (e.target as HTMLElement).closest('button');
      if (btn && pickLoco(el, btn)) { read(); return; }
      const a = btn?.dataset.a;
      if (a === 'back') this.main();
      if (a === 'go') {
        const { coaches, loaded, n } = read();
        if (n > 24) return;
        const v = (k: string) => (el.querySelector(`[data-f="${k}"]`) as HTMLInputElement).value;
        const track = (el.querySelector('[data-f="track"]') as HTMLSelectElement | null)?.value;
        this.cb.start('free-roam', { startStation: v('station'), track, time: v('time'), weather: v('weather') as WeatherId, consist: { loco: v('loco'), coaches, loaded } });
      }
    });
    this.show(el);
  }

  help(back: () => void) {
    const el = html(`<div class="menu helpmenu">${isTouch ? TOUCH_HELP_HTML : HELP_HTML}${creditsHtml()}<div class="buttons"><button data-a="back">Back</button></div></div>`);
    el.addEventListener('click', e => { if ((e.target as HTMLElement).closest('button')?.dataset.a === 'back') back(); });
    this.show(el, back);
  }

  /** Pause menu (opened by the top-left button or Esc). */
  pause(cb: PauseCallbacks) {
    const el = html(`<div class="menu pause"><h2>Paused</h2><p class="sub">${esc(cb.title)}</p><div class="buttons vertical">
      <button data-a="resume">&#9654;&nbsp; Resume</button>
      <button data-a="tutorial">&#127891;&nbsp; Tutorial &mdash; how to start the train</button>
      <button data-a="god">&#9889;&nbsp; God Mode${cb.godActive ? ' <span class="pill">ON</span>' : ''}</button>
      <button data-a="controls">&#9000;&nbsp; Controls</button>
      <button data-a="settings">&#9881;&nbsp; Settings</button>
      <button data-a="restart">&#8635;&nbsp; Restart scenario</button>
      <button data-a="quit">&#8962;&nbsp; Main Menu</button></div>
      ${isTouch ? '' : '<p class="note">&uarr; &darr; to choose, Enter to select, Esc to resume</p>'}</div>`);
    const again = () => this.pause(cb);
    el.addEventListener('click', e => {
      const a = (e.target as HTMLElement).closest('button')?.dataset.a;
      if (a === 'resume') cb.resume();
      if (a === 'tutorial') cb.tutorial();
      if (a === 'god') cb.godMode();
      if (a === 'controls') this.help(again);
      if (a === 'settings') this.show(settingsPanel(again, this.cb.captureKey), again);
      if (a === 'restart') this.confirm('Restart this scenario?', 'Your current progress will be lost.', 'Restart', cb.restart, again);
      if (a === 'quit') this.confirm('Return to the main menu?', 'Are you sure? Progress will be lost.', 'Main Menu', cb.quit, again);
    });
    this.show(el, null);
  }

  /** Yes/no confirmation; Esc or Cancel goes back. */
  confirm(title: string, text: string, ok: string, onOk: () => void, back: () => void) {
    const el = html(`<div class="menu confirm"><h2>${esc(title)}</h2><p>${esc(text)}</p>
      <div class="buttons"><button data-a="cancel">Cancel</button><button data-a="ok">${esc(ok)}</button></div></div>`);
    el.addEventListener('click', e => {
      const a = (e.target as HTMLElement).closest('button')?.dataset.a;
      if (a === 'cancel') back();
      if (a === 'ok') onOk();
    });
    this.show(el, back);
  }

  /** Show any panel (e.g. God Mode) with a back action for Esc. */
  panel(el: HTMLElement, back: (() => void) | null) { this.show(el, back); }

  /** Esc inside menus: go back one level if possible. Returns false when there is nothing to go back to. */
  escape() {
    if (!this.current || !this.back) return false;
    this.back();
    return true;
  }

  /** Arrow-key navigation over the buttons of the open menu. */
  private onKey = (e: KeyboardEvent) => {
    if (!this.current) return;
    const tag = (document.activeElement?.tagName ?? '').toUpperCase();
    if (tag === 'INPUT' || tag === 'SELECT') return;
    if (e.code !== 'ArrowDown' && e.code !== 'ArrowUp') return;
    const buttons = [...this.current.querySelectorAll<HTMLButtonElement>('button:not([disabled])')].filter(b => b.offsetParent !== null);
    if (!buttons.length) return;
    e.preventDefault();
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = i < 0 ? 0 : (i + (e.code === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  };

  report(r: { success: boolean; reason: string; total: number; grade: string; totals: Record<Category, number>; entries: ScoreEntry[]; name: string; distanceKm: number; durationS: number }, cb: { restart(): void; quit(): void }) {
    const el = html(`<div class="menu report"><h2>${r.success ? 'Run complete' : 'Run ended'} - ${esc(r.name)}</h2>
      <p class="reason">${esc(r.reason)}</p>
      <div class="grade ${r.grade}">${r.grade}<small>${r.total} pts</small></div>
      <p>${r.distanceKm.toFixed(1)} km driven in ${formatClock(r.durationS, true)}</p>
      <table class="totals">${(Object.keys(r.totals) as Category[]).map(c => `<tr><td>${CATEGORY_NAMES[c]}</td><td class="${r.totals[c] < 0 ? 'neg' : 'pos'}">${Math.round(r.totals[c])}</td></tr>`).join('')}</table>
      <details><summary>Event log (${r.entries.length})</summary><ul>${r.entries.map(e => `<li class="${e.points < 0 ? 'neg' : 'pos'}">${formatClock(e.time)} ${Math.round(e.points)} - ${esc(e.text)}</li>`).join('')}</ul></details>
      <div class="buttons"><button data-a="restart">Drive again</button><button data-a="quit">Main menu</button></div></div>`);
    el.addEventListener('click', e => {
      const a = (e.target as HTMLElement).closest('button')?.dataset.a;
      if (a === 'restart') cb.restart();
      if (a === 'quit') cb.quit();
    });
    this.show(el);
  }

  loading(text: string, progress: number) {
    let el = this.current?.classList.contains('loading') ? this.current : null;
    if (!el) {
      el = html(`<div class="menu loading"><div class="title"><h1>Rail Bharat</h1></div><p data-l="text"></p><div class="bar"><div></div></div><p class="note">Generating the route, terrain and scenery in the browser...</p></div>`);
      this.show(el);
    }
    el.querySelector<HTMLElement>('[data-l="text"]')!.textContent = text;
    el.querySelector<HTMLElement>('.bar > div')!.style.width = `${Math.round(progress * 100)}%`;
  }

  clickToStart(onGo: () => void) {
    const el = html(`<div class="menu loading"><h1>Ready</h1><p>${isTouch ? 'Menu &rarr; Controls shows how the touch controls work.' : 'Press F1 any time for the controls.'}</p><div class="buttons"><button data-a="go">Start driving</button></div></div>`);
    el.addEventListener('click', e => { if ((e.target as HTMLElement).closest('button')?.dataset.a === 'go') onGo(); });
    this.show(el);
  }

  /** Friendly failure screen: never a frozen or blank page. Technical details are collapsed. */
  error(msg: string) {
    const el = html(`<div class="menu error"><h2>Something went wrong</h2>
      <p>The run had to stop because of an unexpected problem. Your settings are safe.</p>
      <details><summary>Technical details</summary><pre class="err">${esc(msg)}</pre></details>
      <div class="buttons"><button data-a="menu">Back to Main Menu</button></div></div>`);
    el.addEventListener('click', e => {
      if ((e.target as HTMLElement).closest('button')?.dataset.a !== 'menu') return;
      try { sessionStorage.removeItem('railbharat.autostart'); } catch { /* ignore */ }
      location.href = location.pathname;
    });
    this.show(el);
  }
}

/**
 * Locomotive picker: a card per loco with its picture (assets/thumbs/<id>.jpg,
 * captured from the game; a livery-coloured silhouette if a loco has none),
 * name and performance. The choice is kept in a hidden [data-f="loco"] input.
 */
function locoPicker(selected: string, allowDefault: boolean) {
  const card = (id: string, name: string, sub: string, colour: string, img: boolean) => `
    <button type="button" class="loco-card${id === selected ? ' on' : ''}" data-loco="${id}" style="--liv:${colour}">
      ${img ? `<img src="assets/thumbs/${id}.jpg" alt="" loading="lazy" onerror="this.remove()">` : ''}<span class="lc-name">${esc(name)}</span><small>${esc(sub)}</small></button>`;
  return `<input type="hidden" data-f="loco" value="${selected}"><div class="loco-grid">
    ${allowDefault ? card('', 'As in scenario', 'the scenario\'s own loco', '#3a4450', false) : ''}
    ${Object.values(LOCOS).map(l => card(l.id, l.name, `${l.type === 'diesel' ? 'Diesel' : 'Electric'} · ${Math.round(l.maxPowerKW)} kW · ${l.maxSpeedKmph} km/h`, l.livery.body, true)).join('')}</div>`;
}

/** Handle a click on a loco card (true if it was one). */
function pickLoco(root: HTMLElement, b: HTMLElement) {
  if (b.dataset.loco === undefined) return false;
  root.querySelector<HTMLInputElement>('[data-f="loco"]')!.value = b.dataset.loco;
  root.querySelectorAll('.loco-card').forEach(c => c.classList.toggle('on', c === b));
  return true;
}

/** Credits for third-party 3D models (attribution licences such as CC BY), from each loco's model data. */
function creditsHtml() {
  const rows = Object.values(LOCOS).filter(l => l.model?.author && !/FILL IN/.test(l.model.author)).map(l => {
    const m = l.model!, src = /^https:///.test(m.source ?? '') ? `<a href="${esc(m.source!)}" target="_blank" rel="noopener">source</a>` : '';
    return `<li>${esc(l.name)}: "${esc(m.title ?? l.name)}" by ${esc(m.author!)}, ${esc(m.licence ?? '')} ${src} (modified for the game)</li>`;
  });
  return `<h3>Credits</h3><ul class="credits">${rows.join('')}<li>Everything else: original work generated in code. Fictional operator, stations and liveries.</li></ul>`;
}
