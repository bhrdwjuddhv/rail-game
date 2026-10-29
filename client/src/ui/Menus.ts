import { loadSave, settings } from '../core/Settings';
import { playableRoutes, prepareSpan } from '../routemode/prepare';
import { COACHES, LOCOS, REGIONS, ROUTES, SCENARIOS } from '../data';
import { WEATHER, WeatherId } from '../environment/Weather';
import type { ScenarioOverrides } from '@rail/shared/gameplay/Scenario';
import { CATEGORY_NAMES, Category, ScoreEntry } from '@rail/shared/gameplay/Scoring';
import { formatClock } from '@rail/shared/util';
import { settingsPanel } from './Settings';
import { assets } from '../core/AssetRegistry';
import { isTouch } from '../input/Device';
import CREDITS from '../../../data/credits.json';
import { PRESETS, RouteModeMenu, WX_ICON } from './routemode/RouteModeMenu';
import type { Journey, JourneyStop } from '@rail/shared/routemode/Journey';
import type { JourneySummary } from '../routemode/JourneyRun';
import { icon } from './theme/icons';
import './landing.css';
import './scenarios.css';
import './freeroam.css';

/** the landing page's pictures (public/assets/menu) */
const MENU_IMG = (name: string) => `${import.meta.env.BASE_URL}assets/menu/${name}.webp`;
/** the scenarios page's pictures (public/assets/scenarios): one per scenario id, and the header */
const SCEN_IMG = (name: string) => `${import.meta.env.BASE_URL}assets/scenarios/${name}.webp`;
const DIFFICULTIES = ['Easy', 'Medium', 'Hard', 'Expert'];

export interface PauseCallbacks {
  title: string; godActive: boolean;
  resume(): void; tutorial(): void; godMode(): void; restart(): void; quit(): void;
  /** leave Record Mode (shown only while it is open; it starts from the main menu) */
  record?: () => void;
  /** Route Mode: edit the plan for the stations still ahead */
  plan?: () => void;
}

export interface MenuCallbacks {
  start(scenarioId: string, o: ScenarioOverrides, opts?: { tutorial?: boolean; record?: boolean }): void;
  captureKey(cb: (code: string) => void): void;
}

/** Help on phones and tablets: the on-screen controls instead of keys. */
const TOUCH_HELP_HTML = `
<h2>Driving Rail Bharat</h2>
<div class="cols help">
<section><h3>Getting moving</h3>
<ol><li>Tap the <b>pantograph</b> button in the bottom bar and wait for its LED to turn green</li>
<li>Tap <b>${icon('more')}</b> and close the <b>Main breaker</b>, then <b>Release</b> the loco brake</li>
<li>Tap <b>F</b> on the <b>REVERSER</b> switch (top right)</li>
<li>Push the <b>BRAKE</b> lever up to <b>Run</b>; wait for a yellow or green signal (top-left card)</li>
<li>Push the <b>THROTTLE</b> lever up a few notches</li></ol>
<h3>On screen</h3><table>
<tr><td>Levers (right)</td><td>BRAKE: Rel at the top to Full at the bottom. THROTTLE: notches, each one clicks. Settings &rarr; Lever layout can put the throttle on the left edge</td></tr>
<tr><td>Bottom bar</td><td>EMERGENCY STOP (hold half a second), wipers, pantograph, headlight, cab light, marker lights, &#8943; More</td></tr>
<tr><td>LEDs</td><td>Green on, grey off, blinking amber while changing</td></tr>
<tr><td>Horn (blue)</td><td>Tap for a short blast, hold for a long one</td></tr>
<tr><td>Left cards</td><td>Next signal, next speed limit, next station. Tap them for all the gauges</td></tr>
<tr><td>${icon('more')} More</td><td>Main breaker, sander, vigilance, flasher, loco brake, free camera, all gauges, map</td></tr>
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
    // the landing page's artwork (preloaded: set once it is in, so it fades in whole)
    const bgUrl = MENU_IMG('rail-bharat-background'), pre = new Image();
    pre.onload = () => { this.images.main = bgUrl; setImg(); };
    pre.onerror = () => assets.uiImage('mainMenuBg').then(u => { this.images.main = u; setImg(); });
    pre.src = bgUrl;
    assets.uiImage('loadingBg').then(u => { this.images.loading = u; setImg(); });
    assets.uiImage('logo').then(u => { this.logo = u; if (u) this.root.querySelectorAll<HTMLElement>('.title').forEach(t => this.applyLogo(t)); });
    this.refreshBg = setImg;
  }

  /** Route Mode: journeys from the main menu; the plan editor from the pause menu */
  private routeMode = new RouteModeMenu({
    show: (el, back) => this.show(el, back),
    main: () => this.main(),
    start: (j: Journey) => this.cb.start('route-mode', { journey: j }),
  });

  /** Pause menu "Change plan for remaining stops": the timeline for the stations ahead. */
  editJourney(j: Journey, ahead: string[], done: (stops: JourneyStop[]) => void, back: () => void) {
    this.routeMode.editRemaining(j, ahead, done, back);
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

  /**
   * The main page's corners (outside the menu panel, on the page itself): Record Mode top right (a camera,
   * its name sliding out on hover), Instagram bottom right. Shown with the main menu only.
   */
  private corners: HTMLElement | null = null;
  private cornersFor(main: boolean) {
    if (main && !this.corners) {
      const c = this.corners = document.createElement('div');
      c.className = 'menu-corners';
      c.innerHTML = `${isTouch ? '' : `<button data-a="record" class="rec-corner" title="Record Mode: a studio for making videos">${icon('videoCamera')}<span>Record Mode</span></button>`}
        <a class="social-ig" href="https://www.instagram.com/railbhaarat/" target="_blank" rel="noopener noreferrer" title="Rail Bharat on Instagram" aria-label="Rail Bharat on Instagram">${icon('instagram')}</a>`;
      c.addEventListener('click', e => { if ((e.target as HTMLElement).closest('[data-a="record"]')) this.recordSetup(); });
      this.root.appendChild(c);
    }
    if (this.corners) this.corners.hidden = !main;
  }

  private show(el: HTMLElement | null, back: (() => void) | null = null) {
    // (the landing page has its own quick links: no floating corners over it)
    this.cornersFor(!!el?.classList.contains('main') && !el.classList.contains('landing') && !this.inGame);
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

  /** Fade the loading screen out over the running game (no hard cut to a blank canvas). */
  async reveal() {
    if (!this.current) return;
    this.root.classList.add('revealing');
    await new Promise(r => setTimeout(r, 380));
    this.root.classList.remove('revealing');
    this.hide();
  }
  get open() { return !!this.current; }

  main() {
    const driving = settings.get().driving;
    // the landing page: logo and motto, the Scenarios card, three cards, the driving-controls switch; quick links
    // top right; a footer bar (pictures: public/assets/menu, cropped to fit - see landing.css)
    const card = (a: string, img: string, pos: string, ic: Parameters<typeof icon>[0], name: string, sub: string, extra = '') =>
      `<button class="lp-card" data-a="${a}" style="--img:url('${MENU_IMG(img)}');--pos:${pos}"${extra}>${icon(ic)}<span><b>${name}</b><small>${sub}</small></span></button>`;
    const el = html(`<div class="menu main landing">
      <div class="lp-main">
        <div class="title lp-brand"><h1>Rail Bharat</h1><p class="lp-tag">Indian railway simulator</p>
          <p class="lp-motto"><i></i>Discover &middot; <b>Drive</b> &middot; Explore<i></i></p></div>
        <button class="lp-hero" data-a="scenarios" style="--img:url('${MENU_IMG('scenarios-card')}');--pos:right 62%">
          <span class="lp-text"><span class="lp-kicker">Start your journey</span><span class="lp-h">Scenarios</span>
          <span class="lp-sub">Set runs on the routes: timetables, signals, station stops and goods work.</span></span>
          <span class="lp-go">${icon('arrowRight')}</span></button>
        <div class="lp-cards">
          ${card('free', 'free-roam-card', '70% 70%', 'compass', 'Free Roam', 'Explore India at your own pace')}
          ${card('route', 'route-mode-card', 'center', 'mapPin', 'Route Mode', 'Journeys across the network')}
          ${card('tutorial', 'tutorial-card', '78% 40%', 'tutorial', 'Tutorial', 'Learn to start a loco', ' aria-expanded="false"')}
        </div>
        <div class="tut-pick" hidden><span>Which loco?</span>
          <button data-a="tutorial-electric">${icon('pantograph')}Electric <small>pantograph and breaker</small></button>
          <button data-a="tutorial-diesel">${icon('engineStart')}Diesel <small>fuel pump and engine</small></button></div>
        <div class="lp-drive" role="group" aria-label="Driving controls"><span class="lp-label">Driving controls</span>
          <div class="lp-seg">
            <button data-dm="beginner" class="${driving === 'beginner' ? 'on' : ''}" aria-pressed="${driving === 'beginner'}" title="Every run starts ready to go: engine running or pantograph up, brakes released, reverser forward">${icon('gamepad')}<span><b>Beginner</b><small>Simplified controls</small></span></button>
            <button data-dm="advanced" class="${driving === 'advanced' ? 'on' : ''}" aria-pressed="${driving === 'advanced'}" title="The full start-up, as a real driver does it">${icon('sliders')}<span><b>Advanced</b><small>Realistic simulation</small></span></button>
          </div></div>
      </div>
      <nav class="lp-top" aria-label="Quick links">
        <button data-a="settings" title="Settings"><span class="ic-box">${icon('gear')}</span><span>Settings</span></button>
        <button data-a="help" title="Controls and help"><span class="ic-box">${icon('help')}</span><span>Help</span></button>
        ${isTouch ? '' : `<button data-a="record" title="Record Mode: a studio for making videos"><span class="ic-box">${icon('videoCamera')}</span><span>Record</span></button>`}
        <a class="lp-ig" href="https://www.instagram.com/railbhaarat/" target="_blank" rel="noopener noreferrer" title="Rail Bharat on Instagram"><span class="ic-box">${icon('instagram')}</span><span>Instagram</span></a>
      </nav>
      <footer class="lp-foot">
        <button data-a="online" class="soon" aria-disabled="true" title="Multiplayer is on its way">${icon('globe')}<span><b>Play Online</b></span><em>Coming soon</em></button>
        <button data-a="settings">${icon('gear')}<span><b>Settings</b><small>Graphics, sound and controls</small></span></button>
        <button data-a="help">${icon('help')}<span><b>Controls &amp; Help</b><small>Keys, signals and guides</small></span></button>
        <p class="note">Fictional operator, stations and liveries. Everything is generated in the browser.</p>
      </footer></div>`);
    el.addEventListener('click', e => {
      const btn = (e.target as HTMLElement).closest('button');
      if (btn?.dataset.dm) {
        settings.set({ driving: btn.dataset.dm as 'beginner' | 'advanced' });
        el.querySelectorAll<HTMLElement>('[data-dm]').forEach(b => { b.classList.toggle('on', b.dataset.dm === btn.dataset.dm); b.setAttribute('aria-pressed', String(b.dataset.dm === btn.dataset.dm)); });
        return;
      }
      const a = btn?.dataset.a;
      if (a === 'tutorial') {
        // the tutorial: which kind of loco to learn on
        const pick = el.querySelector<HTMLElement>('.tut-pick')!;
        pick.hidden = !pick.hidden;
        btn!.setAttribute('aria-expanded', String(!pick.hidden));
        return;
      }
      if (a === 'scenarios') this.scenarios();
      if (a === 'free') this.freeRoam();
      if (a === 'route') this.routeMode.open();
      if (a === 'record') this.recordSetup();
      if (a === 'tutorial-electric') this.cb.start('free-roam', { startStation: 'SNGH', time: '09:00', weather: 'clear' }, { tutorial: true });
      if (a === 'settings') this.show(settingsPanel(() => this.main(), this.cb.captureKey), () => this.main());
      if (a === 'help') this.help(() => this.main());
      if (a === 'tutorial-diesel') this.cb.start('free-roam', { startStation: 'SNGH', time: '09:00', weather: 'clear', loco: 'wdm-3d' }, { tutorial: true });
      if (a === 'online') {
        const b = el.querySelector<HTMLElement>('[data-a="online"] em')!;
        b.textContent = 'Coming soon: drive with friends on the same line';
        setTimeout(() => { b.textContent = 'Coming soon'; }, 2600);
      }
    });
    this.show(el);
  }

  scenarios() {
    const best = loadSave().best;
    const list = Object.values(SCENARIOS).filter(s => s.id !== 'free-roam' && s.id !== 'route-mode');
    // grouped by route, each with its length and stations; filtered by route and difficulty
    const routes = [...new Set(list.map(s => s.route))];
    const routeHead = (id: string) => {
      const r = ROUTES[id];
      return `<h3 class="sp-sec">${icon('train')}<b>${esc(r?.name ?? id)}</b>${r ? `<small>${r.lengthKm} km &middot; ${r.stations.length} stations &middot; ${r.stations.map(x => esc(x.name)).join(' &ndash; ')}</small>` : ''}</h3>`;
    };
    // a picture card (public/assets/scenarios/<id>.webp, cropped to fit), the text over its darkened foot
    const card = (s: (typeof list)[number]) => {
      const n = s.consist.coaches.reduce((a, c) => a + c.count, 0);
      const goods = s.consist.coaches.every(c => COACHES[c.type]?.kind && COACHES[c.type].kind !== 'coach');
      return `<article class="sp-card" data-diff="${esc(s.difficulty)}" style="--img:url('${SCEN_IMG(s.id)}')">
        <span class="sp-badge" data-d="${esc(s.difficulty.toLowerCase())}">${esc(s.difficulty)}</span>
        <div class="sp-body"><h4>${esc(s.name)}</h4><p>${esc(s.description)}</p>
        <p class="sp-meta"><span>${icon('clock')}${s.time}</span><span>${icon(WX_ICON[s.weather])}${WEATHER[s.weather].name}</span><span>${icon(goods ? 'wagon' : 'coach')}${n} ${goods ? 'wagons' : 'coaches'}</span>${best[s.id] ? `<span>${icon('star')}Best <b>${best[s.id].score} (${best[s.id].grade})</b></span>` : ''}</p></div>
        <button class="sp-drive" data-id="${s.id}">Drive${icon('arrowRight')}</button></article>`;
    };
    const chip = (f: string, v: string, label: string) => `<button class="sp-chip${v ? '' : ' on'}" data-f="${f}" data-v="${esc(v)}"${v ? ` data-d="${esc(v.toLowerCase())}"` : ''}>${label}</button>`;
    const el = html(`<div class="menu scen-page">
      <header class="sp-head" style="--img:url('${SCEN_IMG('scenarios-header')}')">
        <div class="title sp-brand"><h1>Rail Bharat</h1></div>
        <h2>Scenarios</h2><p>Choose your next journey</p>
        <button class="sp-back" data-a="back">${icon('arrowLeft')}Back</button>
      </header>
      <section class="sp-locos"><h3 class="sp-sec">${icon('loco')}<b>Locomotive</b><small>Choose your locomotive for this scenario</small></h3>${locoPicker('', true)}</section>
      <div class="sp-filters">
        <div class="sp-group">${icon('route')}<b>Route group</b>${chip('route', '', 'All')}${routes.map(id => chip('route', id, esc(ROUTES[id]?.name ?? id))).join('')}</div>
        <div class="sp-group">${icon('sliders')}<b>Difficulty</b>${chip('diff', '', 'All')}${DIFFICULTIES.map(d => chip('diff', d, d)).join('')}</div>
      </div>
      ${routes.map(id => `<section class="sp-route" data-route="${id}">${routeHead(id)}<div class="sp-cards">${list.filter(s => s.route === id).map(card).join('')}</div></section>`).join('')}
      <p class="sp-none" hidden>No scenarios match these filters.</p></div>`);
    const filter = { route: '', diff: '' };
    const applyFilter = () => {
      let any = false;
      el.querySelectorAll<HTMLElement>('.sp-route').forEach(sec => {
        let shown = 0;
        sec.querySelectorAll<HTMLElement>('.sp-card').forEach(c => { c.hidden = !!filter.diff && c.dataset.diff !== filter.diff; if (!c.hidden) shown++; });
        sec.hidden = (!!filter.route && sec.dataset.route !== filter.route) || !shown;
        any ||= !sec.hidden;
      });
      el.querySelector<HTMLElement>('.sp-none')!.hidden = any;
    };
    el.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      if (pickLoco(el, b)) return;
      if (b.dataset.a === 'back') this.main();
      if (b.dataset.f === 'route' || b.dataset.f === 'diff') {
        filter[b.dataset.f] = b.dataset.v ?? '';
        el.querySelectorAll<HTMLElement>(`.sp-chip[data-f="${b.dataset.f}"]`).forEach(c => c.classList.toggle('on', c === b));
        applyFilter();
      }
      if (b.dataset.id) {
        const loco = (el.querySelector('[data-f="loco"]') as HTMLInputElement).value;
        this.cb.start(b.dataset.id, loco ? { loco } : {});
      }
    });
    this.show(el, () => this.main());
  }

  /** Record Mode setup: only where and when. The studio opens in a free camera over that station, no train of your own. */
  recordSetup(routeId = SCENARIOS['free-roam'].route) {
    const fr = SCENARIOS['free-roam'];
    const route = ROUTES[routeId] ?? ROUTES[fr.route];
    const el = html(`<div class="menu free rec-setup"><h2>${icon('film')} Record Mode</h2>
      <p class="sub">Pick the place and the light. You start in a free camera above the station; spawn trains, set cameras and film looks inside.</p>
      <div class="cols"><section>
        <label>Route <select data-f="route">${playableRoutes().map(r => `<option value="${r.id}" ${r.id === route.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
        <label>Station <select data-f="station">${route.stations.map(s => `<option value="${s.code}">${esc(s.name)} (${s.code}, km ${s.km})</option>`).join('')}</select></label>
        <label>Time <input type="time" value="${fr.time}" data-f="time"></label>
        <label>Weather <select data-f="weather">${(Object.keys(WEATHER) as WeatherId[]).map(w => `<option value="${w}">${WEATHER[w].name}</option>`).join('')}</select></label>
      </section></div>
      <div class="buttons"><button data-a="back">Back</button><button data-a="go">Start</button></div></div>`);
    el.querySelector<HTMLSelectElement>('[data-f="route"]')!.addEventListener('change', e => this.recordSetup((e.target as HTMLSelectElement).value));
    el.addEventListener('click', e => {
      const a = (e.target as HTMLElement).closest('button')?.dataset.a;
      const v = (k: string) => (el.querySelector(`[data-f="${k}"]`) as HTMLInputElement).value;
      if (a === 'back') this.main();
      // the game still needs a train of yours: a light engine, kept out of sight and out of the signalling
      if (a === 'go') this.cb.start('free-roam', { route: route.id, startStation: v('station'), time: v('time'), weather: v('weather') as WeatherId, consist: { loco: fr.consist.loco, coaches: [], loaded: true } }, { record: true });
    });
    this.show(el, () => this.main());
  }

  freeRoam(routeId = SCENARIOS['free-roam'].route) {
    const fr = SCENARIOS['free-roam'];
    const routes = playableRoutes();
    let base = ROUTES[routeId] && !routeId.includes('~') && !routeId.startsWith('rm:') ? ROUTES[routeId] : ROUTES[fr.route];
    // the route as driven: with the junction at each end (stations and lines from it)
    let route = ROUTES[prepareSpan(base.id)] ?? base;
    // pictures from the scenarios: a route's own, and the one nearest the chosen light and weather
    const shots = Object.values(SCENARIOS).filter(s => s.id !== 'free-roam' && s.id !== 'route-mode');
    const routeImg = (id: string) => { const s = shots.find(s => s.route === id); return s ? SCEN_IMG(s.id) : MENU_IMG('free-roam-card'); };
    const hours = (t: string) => { const [h, m] = t.split(':').map(Number); return (h || 0) + (m || 0) / 60; };
    const lightImg = (time: string, w: WeatherId) => {
      const score = (s: (typeof shots)[number]) => { const d = Math.abs(hours(s.time) - hours(time)); return Math.min(d, 24 - d) + (s.weather === w ? 0 : 6); };
      return shots.length ? SCEN_IMG(shots.reduce((x, y) => (score(y) < score(x) ? y : x)).id) : MENU_IMG('free-roam-card');
    };
    const thumb = (id: string) => `${import.meta.env.BASE_URL}assets/thumbs/${id}.jpg`;
    const typeName = (t: string) => (t === 'diesel' ? 'Diesel' : t === 'trainset' ? 'Trainset' : 'Electric');
    const counts: Record<string, number> = {};
    for (const c of Object.values(COACHES)) if (c.windows !== 'none') counts[c.id] = fr.consist.coaches.find(x => x.type === c.id)?.count ?? 0;
    // presets: the free-roam train and Route Mode's passenger trains (those made of these coaches)
    const presets: [string, { type: string; count: number }[]][] = [['Free roam default', fr.consist.coaches],
      ...Object.entries(PRESETS).filter(([, p]) => p.coaches.every(c => c.type in counts)).map(([n, p]) => [n, p.coaches] as [string, { type: string; count: number }[]])];
    const tally = (cs: { type: string; count: number }[]) => {
      const t: Record<string, number> = {};
      for (const c of cs) t[c.type] = (t[c.type] ?? 0) + c.count;
      return t;
    };
    // a coach drawn in its livery (there are no coach pictures): roof, windows, band, body
    const coachArt = (id: string) => {
      const l = COACHES[id].livery;
      return `<span class="fr-coach-art" style="--body:${l.body};--band:${l.band};--roof:${l.roof};--win:${l.window}" aria-hidden="true"></span>`;
    };
    const el = html(`<div class="menu fr-page">
      <header class="fr-head" style="--img:url('${MENU_IMG('free-roam-card')}')">
        <button class="fr-x" data-a="back" title="Back" aria-label="Back">${icon('caretLeft')}</button>
        <span class="fr-mark">${icon('compass')}</span>
        <div class="fr-titles"><h2>Free Roam</h2><p class="fr-motto">Explore<i></i>Drive<i></i>Discover</p></div>
        <div class="title fr-brand"><h1>Rail Bharat</h1></div>
      </header>
      <div class="fr-grid">
        <section class="fr-panel fr-route"><h3 class="fr-h"><span class="fr-n">1</span>Select Route</h3>
          <div class="fr-route-card" data-f="route-card"></div>
          <div class="fr-dots">${routes.map(r => `<button data-route="${r.id}" title="${esc(r.name)}" aria-label="${esc(r.name)}"></button>`).join('')}</div>
        </section>
        <section class="fr-panel fr-start"><h3 class="fr-h"><span class="fr-n">2</span>${icon('mapPin')}Starting Point</h3>
          <label class="fr-field"><span>Station</span><select data-f="station"></select></label>
          <label class="fr-field" data-f="track-row"><span>Line</span><select data-f="track"></select></label>
          <p class="fr-note">The junction at each end is part of the run: stop there to carry on along another route.</p>
        </section>
        <section class="fr-panel fr-cond"><h3 class="fr-h"><span class="fr-n">3</span>${icon('sun')}Conditions</h3>
          <div class="fr-cond-body"><div class="fr-cond-fields">
            <label class="fr-field"><span>${icon('clock')}Time</span><input type="time" value="${fr.time}" data-f="time"></label>
            <label class="fr-field"><span data-f="wx-icon">${icon(WX_ICON[fr.weather])}</span><span>Weather</span><select data-f="weather">${(Object.keys(WEATHER) as WeatherId[]).map(w => `<option value="${w}" ${w === fr.weather ? 'selected' : ''}>${WEATHER[w].name}</option>`).join('')}</select></label>
          </div><div class="fr-light" data-f="light"></div></div>
        </section>
        <section class="fr-panel fr-loco"><h3 class="fr-h"><span class="fr-n">4</span>Select Locomotive</h3>
          <input type="hidden" data-f="loco" value="${fr.consist.loco}">
          <div class="fr-loco-show" data-f="loco-show"></div>
          <div class="fr-strip-wrap"><button class="fr-arr" data-a="strip" data-d="-1" aria-label="Scroll left">${icon('caretLeft')}</button>
            <div class="fr-strip">${Object.values(LOCOS).map(l => `<button class="fr-thumb" data-loco="${l.id}" style="--img:url('${thumb(l.id)}');--liv:${l.livery.body}"><span>${esc(l.name)}</span></button>`).join('')}</div>
            <button class="fr-arr" data-a="strip" data-d="1" aria-label="Scroll right">${icon('caretRight')}</button></div>
        </section>
        <section class="fr-panel fr-consist"><h3 class="fr-h"><span class="fr-n">5</span>Train Consist
          <span class="fr-seg" role="tablist"><button data-tab="preset" role="tab" aria-selected="false">Preset</button><button data-tab="custom" role="tab" aria-selected="true">Custom</button></span></h3>
          <div class="fr-presets" data-f="presets" hidden>${presets.map(([n, cs], i) => `<button class="fr-preset" data-preset="${i}"><b>${esc(n)}</b><small>${Object.entries(tally(cs)).map(([t, k]) => `${k} ${esc(COACHES[t]?.name ?? t)}`).join(' &middot; ')}</small></button>`).join('')}</div>
          <div class="fr-coaches" data-f="coaches">${Object.keys(counts).map(id => `<div class="fr-row">${coachArt(id)}<span class="fr-cname"><b>${esc(COACHES[id].name)}</b><small>${COACHES[id].seats ?? 72} seats &middot; ${COACHES[id].lengthM.toFixed(1)} m</small></span>
            <span class="fr-step"><button data-step="${id}" data-d="-1" aria-label="One fewer">${icon('minus')}</button><input type="number" min="0" max="24" value="${counts[id]}" data-c="${id}" aria-label="${esc(COACHES[id].name)}"><button data-step="${id}" data-d="1" aria-label="One more">${icon('plus')}</button></span></div>`).join('')}</div>
          <label class="fr-loaded"><input type="checkbox" checked data-f="loaded"> Loaded (passengers aboard)</label>
          <div class="fr-sum"><div>${icon('coach')}<b data-s="n"></b><small>Coaches</small></div><div>${icon('freightLoad')}<b data-s="t"></b><small>Estimated weight</small></div><div>${icon('route')}<b data-s="m"></b><small>Train length</small></div></div>
          <p class="fr-warn" data-f="summary"></p>
        </section>
      </div>
      <footer class="fr-foot"><span class="fr-mark">${icon('compass')}</span>
        <div class="fr-about"><b>Free Roam Mode</b><p>Explore the route, drive at your own pace, follow the signals and enjoy the journey.<br>No fixed objectives: just you, the train and the tracks.</p></div>
        <button class="fr-back" data-a="back">Back</button><button class="fr-go" data-a="go">${icon('play')}Start Free Roam</button></footer></div>`);
    const q = <T extends HTMLElement>(sel: string) => el.querySelector<T>(sel)!;
    const v = (k: string) => q<HTMLInputElement>(`[data-f="${k}"]`).value;
    // the chosen route: its card, dots, stations and lines
    const showRoute = () => {
      const i = routes.indexOf(base), names = [...new Set((base.regions ?? []).map(r => REGIONS[r.region]?.name).filter(Boolean))];
      q('[data-f="route-card"]').innerHTML = `<div class="fr-route-img" style="--img:url('${routeImg(base.id)}')"></div>
        <button class="fr-arr" data-a="route" data-d="-1" aria-label="Previous route">${icon('caretLeft')}</button><button class="fr-arr" data-a="route" data-d="1" aria-label="Next route">${icon('caretRight')}</button>
        <div class="fr-route-text"><b>${esc(base.name)}</b><small>${names.map(esc).join(' &middot; ')}</small></div>
        <div class="fr-route-stats"><span>${icon('mapPin')}${base.lengthKm} km</span><span>${icon('junction')}${base.lines && base.lines.length > 1 ? 'Double line' : 'Single line'}</span><span>${icon('platform')}${base.stations.length} stations</span></div>`;
      el.querySelectorAll<HTMLElement>('.fr-dots button').forEach((d, k) => d.classList.toggle('on', k === i));
      q('[data-f="station"]').innerHTML = route.stations.map(s => `<option value="${s.code}">${esc(s.name)} (${s.code}, km ${s.km})</option>`).join('');
      const two = !!route.lines && route.lines.length > 1;
      q('[data-f="track-row"]').hidden = !two;
      q('[data-f="track"]').innerHTML = two ? `<option value="DOWN">Down line (towards ${esc(route.stations[route.stations.length - 1].name)})</option><option value="UP">Up line (towards ${esc(route.stations[0].name)})</option>` : '';
    };
    const setRoute = (id: string) => { base = ROUTES[id]; route = ROUTES[prepareSpan(base.id)] ?? base; showRoute(); };
    const showLight = () => {
      const w = v('weather') as WeatherId;
      q('[data-f="light"]').style.setProperty('--img', `url('${lightImg(v('time') || fr.time, w)}')`);
      q('[data-f="wx-icon"]').innerHTML = icon(WX_ICON[w]);
    };
    // the chosen loco: picture, what it is, its numbers
    const showLoco = () => {
      const L = LOCOS[v('loco')];
      if (!L) return;
      el.querySelectorAll<HTMLElement>('.fr-thumb').forEach(t => t.classList.toggle('on', t.dataset.loco === L.id));
      q('[data-f="loco-show"]').innerHTML = `<div class="fr-loco-img" style="--img:url('${thumb(L.id)}');--liv:${L.livery.body}"></div>
        <div class="fr-loco-info"><h4>${esc(L.name)}</h4><p class="fr-kind">${typeName(L.type)}${L.role ? ` &middot; ${esc(L.role)}` : ''}</p>
        ${L.description ? `<p class="fr-desc">${esc(L.description)}</p>` : ''}
        <dl><div>${icon('lightning')}<dt>Power</dt><dd>${Math.round(L.maxPowerKW).toLocaleString('en-IN')} kW</dd></div>
        <div>${icon('fastForward')}<dt>Max speed</dt><dd>${L.maxSpeedKmph} km/h</dd></div>
        <div>${icon('couple')}<dt>Tractive effort</dt><dd>${Math.round(L.maxTractiveEffortKN)} kN</dd></div></dl>
        <span class="fr-tag">${typeName(L.type)}</span></div>`;
    };
    const summary = q('[data-f="summary"]'), go = q<HTMLButtonElement>('[data-a="go"]');
    const sum = (k: string, t: string) => { q(`[data-s="${k}"]`).textContent = t; };
    const read = () => {
      // a fixed trainset (bullet train): its own cars only, nothing to add
      const L = LOCOS[v('loco')];
      el.querySelectorAll<HTMLInputElement | HTMLButtonElement>('[data-c], [data-step], .fr-preset').forEach(i => { i.disabled = !!L?.trainset; });
      if (L?.trainset) {
        sum('n', '0'); sum('t', `${Math.round(L.massT)} t`); sum('m', `${Math.round(L.lengthM)} m`);
        summary.textContent = `Fixed trainset: ${L.trainset.cars.length} cars - coaches cannot be added`;
        go.disabled = false;
        return { coaches: [], loaded: true, n: 0 };
      }
      const coaches = Object.keys(counts).map(id => ({ type: id, count: Math.max(0, Math.min(24, Number(q<HTMLInputElement>(`[data-c="${id}"]`).value) || 0)) })).filter(c => c.count > 0);
      const n = coaches.reduce((a, c) => a + c.count, 0);
      const loaded = q<HTMLInputElement>('[data-f="loaded"]').checked;
      const mass = (L?.massT ?? 0) + coaches.reduce((a, c) => a + c.count * (loaded ? COACHES[c.type].massLoadedT : COACHES[c.type].massEmptyT), 0);
      const len = (L?.lengthM ?? 20.56) + coaches.reduce((a, c) => a + c.count * COACHES[c.type].lengthM, 0);
      sum('n', String(n)); sum('t', `${Math.round(mass)} t`); sum('m', `${Math.round(len)} m`);
      summary.textContent = n > 24 ? 'Too long for the platforms: 24 coaches at most' : '';
      go.disabled = n > 24;
      el.querySelectorAll<HTMLElement>('.fr-row').forEach(r => r.classList.toggle('on', Number(r.querySelector<HTMLInputElement>('[data-c]')!.value) > 0));
      return { coaches, loaded, n };
    };
    const tab = (t: string) => {
      el.querySelectorAll<HTMLElement>('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
      q('[data-f="presets"]').hidden = t !== 'preset';
      q('[data-f="coaches"]').hidden = t !== 'custom';
    };
    showRoute(); showLight(); showLoco(); read();
    el.addEventListener('input', read);
    el.addEventListener('change', e => { const f = (e.target as HTMLElement).dataset.f; if (f === 'time' || f === 'weather') showLight(); });
    el.addEventListener('click', e => {
      const btn = (e.target as HTMLElement).closest('button');
      if (!btn) return;
      const a = btn.dataset.a, d = Number(btn.dataset.d);
      if (btn.dataset.loco) { q<HTMLInputElement>('[data-f="loco"]').value = btn.dataset.loco; showLoco(); read(); }
      if (btn.dataset.route) setRoute(btn.dataset.route);
      if (a === 'route') setRoute(routes[(routes.indexOf(base) + d + routes.length) % routes.length].id);
      if (a === 'strip') q('.fr-strip').scrollBy({ left: d * q('.fr-strip').clientWidth * 0.8, behavior: 'smooth' });
      if (btn.dataset.step) {
        const i = q<HTMLInputElement>(`[data-c="${btn.dataset.step}"]`);
        i.value = String(Math.max(0, Math.min(24, (Number(i.value) || 0) + d)));
        read();
      }
      if (btn.dataset.tab) tab(btn.dataset.tab);
      if (btn.dataset.preset) {
        const t = tally(presets[Number(btn.dataset.preset)][1]);
        el.querySelectorAll<HTMLInputElement>('[data-c]').forEach(i => { i.value = String(t[i.dataset.c!] ?? 0); });
        read();
        tab('custom');
      }
      if (a === 'back') this.main();
      if (a === 'go') {
        const { coaches, loaded, n } = read();
        if (n > 24) return;
        const track = route.lines && route.lines.length > 1 ? v('track') : undefined;
        this.cb.start('free-roam', { span: base.id, startStation: v('station'), track, time: v('time'), weather: v('weather') as WeatherId, consist: { loco: v('loco'), coaches, loaded } });
      }
    });
    this.show(el, () => this.main());
  }

  help(back: () => void) {
    const el = html(`<div class="menu helpmenu">${isTouch ? TOUCH_HELP_HTML : HELP_HTML}${creditsHtml()}<div class="buttons"><button data-a="back">Back</button></div></div>`);
    el.addEventListener('click', e => { if ((e.target as HTMLElement).closest('button')?.dataset.a === 'back') back(); });
    this.show(el, back);
  }

  /** Pause menu (opened by the top-left button or Esc). */
  pause(cb: PauseCallbacks) {
    const el = html(`<div class="menu pause"><h2>Paused</h2><p class="sub">${esc(cb.title)}</p><div class="buttons vertical">
      <button data-a="resume">${icon('play')}Resume</button>
      <button data-a="tutorial">${icon('tutorial')}Tutorial &mdash; how to start the train</button>
      <button data-a="god">${icon('lightning')}God Mode${cb.godActive ? ' <span class="pill">ON</span>' : ''}</button>
      ${cb.record ? `<button data-a="record">${icon('film')}Exit Record Mode</button>` : ''}
      ${cb.plan ? `<button data-a="plan">${icon('route')}Change plan for remaining stops</button>` : ''}
      <button data-a="controls">${icon('keyboard')}Controls</button>
      <button data-a="settings">${icon('gear')}Settings</button>
      <button data-a="restart">${icon('restart')}Restart scenario</button>
      <button data-a="quit">${icon('home')}Main Menu</button></div>
      ${isTouch ? '' : '<p class="note">&uarr; &darr; to choose, Enter to select, Esc to resume</p>'}</div>`);
    const again = () => this.pause(cb);
    el.addEventListener('click', e => {
      const a = (e.target as HTMLElement).closest('button')?.dataset.a;
      if (a === 'resume') cb.resume();
      if (a === 'tutorial') cb.tutorial();
      if (a === 'god') cb.godMode();
      if (a === 'record') cb.record?.();
      if (a === 'plan') cb.plan?.();
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

  /** End of a Route Mode journey: time, distance, stops on the mark, smoothness (no strict scoring). */
  journeyReport(s: JourneySummary, cb: { restart(): void; quit(): void }) {
    const onMark = s.stops.filter(x => Math.abs(x.errM) <= 5).length;
    const m = Math.round(s.minutes);
    const el = html(`<div class="menu report journey-report"><h2>${icon('check')} Journey complete</h2><p class="sub">${esc(s.title)}</p>
      <div class="jr-stats">
        <div>${icon('clock')}<b>${m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`}</b><small>on the way</small></div>
        <div>${icon('route')}<b>${s.km.toFixed(1)} km</b><small>driven</small></div>
        <div>${icon('platform')}<b>${onMark} / ${s.stops.length}</b><small>stops within 5 m of the mark</small></div>
        <div>${icon('star')}<b>${s.smooth}%</b><small>smoothness${s.bumps ? ` (${s.bumps} hard bump${s.bumps > 1 ? 's' : ''})` : ''}</small></div>
      </div>
      ${s.stops.length ? `<table class="totals">${s.stops.map(x => `<tr><td>${esc(x.name)}</td><td class="${Math.abs(x.errM) <= 5 ? 'pos' : 'neg'}">${Math.abs(x.errM).toFixed(1)} m ${x.errM > 0 ? 'past' : 'short'}</td></tr>`).join('')}</table>` : ''}
      <div class="buttons"><button data-a="restart">${icon('restart')}Drive it again</button><button data-a="quit">${icon('home')}Main menu</button></div></div>`);
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
    const el = html(`<div class="menu loading"><h1>Ready</h1><p>${isTouch ? 'Menu &rarr; Controls shows how the touch controls work.' : 'Press F1 any time for the controls.'}</p><div class="buttons"><button data-a="go">${icon('play')}Start driving</button></div></div>`);
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
    ${Object.values(LOCOS).map(l => card(l.id, l.name, `${l.type === 'diesel' ? 'Diesel' : l.type === 'trainset' ? 'Fixed trainset' : 'Electric'} · ${Math.round(l.maxPowerKW)} kW · ${l.maxSpeedKmph} km/h`, l.livery.body, true)).join('')}</div>`;
}

/** Handle a click on a loco card (true if it was one). */
function pickLoco(root: HTMLElement, b: HTMLElement) {
  if (b.dataset.loco === undefined) return false;
  root.querySelector<HTMLInputElement>('[data-f="loco"]')!.value = b.dataset.loco;
  root.querySelectorAll('.loco-card').forEach(c => c.classList.toggle('on', c === b));
  return true;
}

/** Credits for third-party 3D models (attribution licences such as CC BY): each loco's model data, then data/credits.json. */
function creditsHtml() {
  const link = (u?: string) => ((u ?? '').startsWith('https://') ? ` <a href="${esc(u!)}" target="_blank" rel="noopener">source</a>` : '');
  const locos = Object.values(LOCOS).filter(l => l.model?.author && !/FILL IN/.test(l.model.author)).map(l => {
    const m = l.model!;
    return `<li>${esc(l.name)}: "${esc(m.title ?? l.name)}" by ${esc(m.author!)}, ${esc(m.licence ?? '')}${link(m.source)} (modified for the game)</li>`;
  });
  const others = (CREDITS as { assets: { title: string; author: string; licence: string; source?: string }[] }).assets.map(a =>
    `<li>"${esc(a.title)}" by ${esc(a.author)}, ${esc(a.licence)}${link(a.source)} (modified for the game)</li>`);
  return `<h3>Credits</h3><ul class="credits">${[...locos, ...others].join('')}<li>Everything else: original work generated in code. Fictional operator, stations and liveries.</li></ul>`;
}
