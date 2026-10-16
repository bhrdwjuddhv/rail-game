import './record.css';
import * as THREE from 'three/webgpu';
import { bus } from '@rail/shared/events';
import type { Menus } from '../ui/Menus';
import type { RecordHost, RecordRunner, Studio, TrackHit } from './host';
import { RecordTrains, TrainRef } from './RecordTrains';
import { PRESETS, RecordCameras } from './RecordCameras';
import { FilmLook } from './FilmLook';
import { WorldTab } from './WorldTab';
import { RecordSettings } from './RecordSettings';
import { Scenes } from './Scenes';
import { icon } from '../ui/theme/icons';

type Tab = 'trains' | 'camera' | 'world' | 'scenes' | 'settings';
const TABS: [Tab, string][] = [['trains', 'Trains'], ['camera', 'Camera'], ['world', 'World'], ['scenes', 'Scenes'], ['settings', 'Settings']];
const SLOW_PRESETS = [0.25, 0.5, 1, 2];

const HELP = `<h3>Record Mode keys</h3><table>
<tr><td>Tab</td><td>Show / hide the Mod Menu</td></tr>
<tr><td>H</td><td>Clean view: no menu, hints, guides or cursor (H again brings them back)</td></tr>
<tr><td>Space</td><td>Freeze the world (cameras still move)</td></tr>
<tr><td>1 &ndash; 9</td><td>Jump to a camera bookmark</td></tr>
<tr><td>Shift + 1 &ndash; 9</td><td>Glide to a bookmark</td></tr>
<tr><td>Ctrl / Alt + 1 &ndash; 9</td><td>Save the camera as a bookmark (Alt if the browser keeps Ctrl + number for tabs)</td></tr>
<tr><td>W A S D, Q / E</td><td>Drone: move, down / up (drag to look, Shift fast, Ctrl slow, wheel: speed)</td></tr>
<tr><td>&uarr; / &darr;</td><td>Driving a spawned train: speed up / down 5 km/h (&larr; stop)</td></tr>
<tr><td>Ctrl + Z</td><td>Undo the last train placed, copied or removed</td></tr>
<tr><td>Click</td><td>Select a train (or the point being picked)</td></tr>
<tr><td>Esc</td><td>Cancel picking, or the pause menu (Exit Record Mode is there too)</td></tr>
<tr><td>F1</td><td>This list</td></tr></table>`;

/**
 * Record Mode: a studio for making videos (desktop, solo). The game's HUD
 * goes, the player's train keeps running, and the Mod Menu opens at the side
 * with Trains, Camera, World, Scenes and Settings. Loaded only when opened.
 */
export class RecordMode implements RecordRunner, Studio {
  readonly trains: RecordTrains;
  readonly cams: RecordCameras;
  readonly film: FilmLook;
  readonly world: WorldTab;
  readonly settings: RecordSettings;
  readonly scenes: Scenes;
  private panel = document.createElement('div');
  private toasts = document.createElement('div');
  private hint = document.createElement('div');
  private help = document.createElement('div');
  /** brings the menu back when it is hidden (not shown in clean view) */
  private showBtn = document.createElement('button');
  private banner = document.createElement('div');
  private tab: Tab = 'trains';
  private menuOpen = true;
  private ui = true;
  private isFrozen = false;
  private slow = 1;
  private pending: (() => void)[] = [];
  private undos: { label: string; undo: () => void }[] = [];
  private picking: { label: string; cb: (hit: TrackHit) => void } | null = null;
  private down: { x: number; y: number } | null = null;
  private raycaster = new THREE.Raycaster();
  private hintTimer = 0;

  constructor(readonly h: RecordHost, private menus: Menus, kept: RecordRunner | null) {
    if (kept instanceof RecordTrains) { kept.attach(this); this.trains = kept; } else this.trains = new RecordTrains(this);
    this.cams = new RecordCameras(this, this.trains);
    this.film = new FilmLook(this);
    this.world = new WorldTab(this, this.trains);
    this.settings = new RecordSettings(this);
    this.scenes = new Scenes(this, { trains: this.trains, cams: this.cams, film: this.film, world: this.world, settings: this.settings });
    this.cams.setFilm(this.film.el);

    // what the parts read from each other
    const followed = () => this.trains.camTarget(this.cams.follow);
    // the game's own cameras follow the followed train (yours: as they always do; none of yours: the first spawned)
    const first = () => (this.trains.list[0] ? this.trains.camTarget({ kind: 'spawned', s: this.trains.list[0] }) : null);
    h.rec.cameraTarget = () => (this.cams.follow.kind === 'player' && !h.player.hidden() ? null : followed() ?? first());
    // the outline goes round the solid parts only (not the headlight beam or glass)
    const solid = new WeakMap<THREE.Object3D, { list: THREE.Object3D[]; at: number }>();
    this.film.outlined = () => {
      const r = this.trains.selected;
      if (!r || !this.trains.alive(r)) return null;
      const g = this.trains.info(r).view.group;
      // listed again now and then: a loco's 3D model replaces its simple body when it has loaded
      let c = solid.get(g);
      if (!c || performance.now() - c.at > 2000) {
        const list: THREE.Object3D[] = [];
        g.traverse(o => { const m = (o as THREE.Mesh).material as THREE.Material | undefined; if ((o as THREE.Mesh).isMesh && m && !m.transparent) list.push(o); });
        solid.set(g, c = { list, at: performance.now() });
      }
      return c.list;
    };
    this.film.focusTarget = () => {
      const tg = followed();
      if (!tg) return null;
      // the vehicle nearest the camera is what should be sharp
      const cam = h.cameras.camera.position, p = new THREE.Vector3();
      let best: THREE.Vector3 | null = null, bd = Infinity;
      for (const m of tg.view.vehicleMatrices) { p.setFromMatrixPosition(m); const d = p.distanceTo(cam); if (d < bd) { bd = d; best = p.clone(); } }
      return best;
    };
    this.settings.trainEar = () => { const tg = followed() ?? this.trains.camTarget({ kind: 'player' }); return tg ? new THREE.Vector3().setFromMatrixPosition(tg.view.vehicleMatrices[0]) : null; };
    this.settings.onPitch = () => this.applyScale();
    this.trains.onDrive = r => this.drive(r);
    this.trains.onStation = code => this.world.cameraTo(code);
    this.trains.followed = s => this.cams.follow.kind === 'spawned' && this.cams.follow.s === s;
    this.world.placeCamera = (pos, look) => {
      this.cams.manual();
      this.cams.use('drone');
      const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(pos, look, new THREE.Vector3(0, 1, 0)));
      this.cams.drone.place(pos, q);
    };

    this.build();
    h.setGameUi(false);
    h.setKeyboardDriving(false);
    this.settings.apply();
    this.world.apply();
    addEventListener('keydown', this.onKey, true);
    addEventListener('beforeunload', this.onUnload);
    h.canvas.addEventListener('pointerdown', this.onDown);
    addEventListener('pointerup', this.onUp);
    // started from the main menu: a free camera over the chosen station
    const at = h.player.startStation();
    if (h.player.hidden() && at) { this.world.cameraTo(at); this.trains.placeAt(at); }
    this.toast(kept instanceof RecordTrains && this.trains.list.length ? `Record Mode: ${this.trains.list.length} trains back under the studio` : 'Record Mode: Tab menu, H clean view, Space freeze, F1 keys');
  }

  // ------------------------------------------------------------------ Studio
  toast(text: string, warn = false) {
    const d = document.createElement('div');
    d.className = `rec-toast${warn ? ' warn' : ''}`;
    d.textContent = text;
    this.toasts.appendChild(d);
    while (this.toasts.children.length > 4) this.toasts.firstElementChild!.remove();
    setTimeout(() => { d.classList.add('fade'); setTimeout(() => d.remove(), 500); }, warn ? 5000 : 3200);
  }

  pick(label: string, cb: (hit: TrackHit) => void) {
    this.picking = { label, cb };
    this.banner.textContent = `${label} (Esc cancels)`;
    this.banner.hidden = false;
    document.body.classList.add('rec-picking');
  }

  private endPick() {
    this.picking = null;
    this.banner.hidden = true;
    document.body.classList.remove('rec-picking');
  }

  mapClick(km: number) {
    if (!this.picking) return false;
    const h = this.h, p = new THREE.Vector3(), f = { x: 0, y: 0, z: 0, heading: 0 } as Parameters<typeof h.route.alignment.sample>[1];
    h.route.alignment.sample(km * 1000, f);
    p.set(f.x, f.y, f.z);
    const pk = this.picking;
    this.endPick();
    pk.cb({ km, x: p.x, y: p.y, z: p.z, line: null });
    return true;
  }

  frozen() { return this.isFrozen; }
  apply(fn: () => void) { if (this.isFrozen) this.pending.push(fn); else fn(); }
  uiVisible() { return this.ui; }
  pushUndo(label: string, undo: () => void) { this.undos.push({ label, undo }); if (this.undos.length > 30) this.undos.shift(); }

  // ------------------------------------------------------------------ the Mod Menu
  private build() {
    const p = this.panel;
    p.className = 'rec-panel';
    p.innerHTML = `
      <header><b>${icon('film')} Record Mode</b><span class="rec-fps" hidden></span><button data-x="hide" title="Hide this menu (Tab); the Menu button brings it back">Hide</button><button data-x="clean" title="Hide everything for recording: menu, messages, guides, cursor (H brings it back)">Clean view</button><button data-x="exit" title="Leave Record Mode">Exit</button></header>
      <div class="rec-time">
        <button data-x="freeze" class="rec-freeze">${icon('pause')} Freeze</button>
        <label>Speed <input type="range" min="0.1" max="2" step="0.05" value="1" data-x="slow"><output>1&times;</output></label>
        <span class="rec-presets">${SLOW_PRESETS.map(v => `<button data-slow="${v}">${v}&times;</button>`).join('')}</span>
      </div>
      <p class="rec-keys">Tab menu &middot; H clean view &middot; Space freeze &middot; F1 keys</p>
      <nav>${TABS.map(([id, n]) => `<button data-tab="${id}">${n}</button>`).join('')}</nav>
      <div class="rec-body"></div>`;
    const body = p.querySelector('.rec-body')!;
    for (const el of [this.trains.el, this.cams.el, this.world.el, this.scenes.el, this.settings.el]) body.appendChild(el);
    this.trains.bind(); this.cams.bind(); this.film.bind(); this.world.bind(); this.scenes.bind(); this.settings.bind();
    p.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      if (b.dataset.tab) this.showTab(b.dataset.tab as Tab);
      if (b.dataset.x === 'freeze') this.freeze(!this.isFrozen);
      if (b.dataset.x === 'exit') this.askExit();
      if (b.dataset.x === 'hide') this.toggleMenu();
      if (b.dataset.x === 'clean') this.setUi(false);
      if (b.dataset.slow) this.setSlow(Number(b.dataset.slow));
      b.blur(); // keys (Space, Tab) go to the studio, not the button
    });
    p.addEventListener('input', e => { const t = e.target as HTMLInputElement; if (t.dataset.x === 'slow') this.setSlow(Number(t.value)); });
    this.toasts.className = 'rec-toasts';
    this.showBtn.className = 'rec-show';
    this.showBtn.innerHTML = `${icon('menu')} Menu`;
    this.showBtn.title = 'Show the Record Mode menu (Tab)';
    this.showBtn.addEventListener('click', () => { this.showBtn.blur(); this.toggleMenu(); });
    this.hint.className = 'rec-hint';
    this.hint.textContent = 'Press H to show UI';
    this.hint.hidden = true;
    this.help.className = 'rec-help';
    this.help.innerHTML = `${HELP}<div class="buttons"><button>Close</button></div>`;
    this.help.hidden = true;
    this.help.addEventListener('click', e => { if ((e.target as HTMLElement).closest('button')) this.help.hidden = true; });
    this.banner.className = 'rec-banner';
    this.banner.hidden = true;
    document.body.append(this.panel, this.showBtn, this.toasts, this.hint, this.help, this.banner);
    document.body.classList.add('rec-on');
    this.showTab('trains');
  }

  private showTab(t: Tab) {
    this.tab = t;
    this.panel.querySelectorAll<HTMLButtonElement>('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    const els: Record<Tab, HTMLElement> = { trains: this.trains.el, camera: this.cams.el, world: this.world.el, scenes: this.scenes.el, settings: this.settings.el };
    for (const [k, el] of Object.entries(els)) el.hidden = k !== t;
    if (t === 'trains') this.trains.render();
    if (t === 'camera') this.cams.render();
    if (t === 'world') this.world.render();
    if (t === 'scenes') this.scenes.render();
    if (t === 'settings') this.settings.render();
  }

  private layout() {
    this.panel.hidden = !this.ui || !this.menuOpen;
    this.showBtn.hidden = !this.ui || this.menuOpen;
    this.toasts.hidden = !this.ui;
    document.body.classList.toggle('rec-clean', !this.ui && this.settings.s.hideCursor);
  }

  /** Hide or show the Mod Menu (Tab, its Hide button, the Menu button); leaves clean view. */
  private toggleMenu() {
    this.menuOpen = !this.menuOpen;
    if (!this.ui) this.ui = true;
    this.hint.hidden = true;
    this.layout();
  }

  /** Clean view (H): nothing on screen but the picture; a short hint how to get the UI back. */
  private setUi(on: boolean) {
    this.ui = on;
    this.help.hidden = true;
    if (!on) this.endPick();
    this.layout();
    clearTimeout(this.hintTimer);
    this.hint.hidden = on;
    if (!on) this.hintTimer = window.setTimeout(() => { this.hint.hidden = true; }, 2000);
  }

  // ------------------------------------------------------------------ freeze and slow motion
  freeze(on: boolean) {
    this.isFrozen = on;
    this.applyScale();
    const b = this.panel.querySelector('.rec-freeze')!;
    b.classList.toggle('on', on);
    b.innerHTML = on ? `${icon('play')} Unfreeze` : `${icon('pause')} Freeze`;
    // sounds stop with the world and carry on where they were
    const a = this.h.audio;
    if (a) { if (on) a.ctx.suspend().catch(() => {}); else a.ctx.resume().catch(() => {}); }
    if (!on) { const p = this.pending; this.pending = []; for (const fn of p) fn(); if (p.length) this.toast(`${p.length} change${p.length > 1 ? 's' : ''} applied`); }
  }

  private setSlow(v: number) {
    this.slow = Math.max(0.1, Math.min(2, v));
    const r = this.panel.querySelector<HTMLInputElement>('[data-x="slow"]')!;
    r.value = String(this.slow);
    (r.nextElementSibling as HTMLOutputElement).textContent = `${Number(this.slow.toFixed(2))}×`;
    this.applyScale();
  }

  private applyScale() {
    this.h.rec.scale = this.isFrozen ? 0 : this.slow;
    this.h.audio?.setRate(this.settings.s.keepPitch || this.isFrozen ? 1 : this.slow);
  }

  // ------------------------------------------------------------------ input
  private onKey = (e: KeyboardEvent) => {
    if (this.menus.open) return; // the pause menu has the keys
    const tag = (e.target as HTMLElement)?.tagName;
    const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
    const own = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (e.code === 'Escape' && this.picking) { own(); this.endPick(); this.toast('Picking cancelled'); return; }
    if (e.code === 'Escape' && !this.help.hidden) { own(); this.help.hidden = true; return; }
    if (typing) return;
    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit) {
      own();
      const i = Number(digit[1]) - 1;
      if (e.ctrlKey || e.altKey || e.metaKey) this.cams.save(i); else this.cams.jump(i, e.shiftKey);
      return;
    }
    if (e.repeat && e.code !== 'ArrowUp' && e.code !== 'ArrowDown') { if (['Tab', 'Space', 'KeyH', 'F1'].includes(e.code)) own(); return; }
    switch (e.code) {
      case 'Tab': own(); this.toggleMenu(); return;
      case 'KeyH': own(); this.setUi(!this.ui); return;
      case 'Space': own(); this.freeze(!this.isFrozen); return;
      case 'F1': own(); this.help.hidden = !this.help.hidden; return;
      case 'KeyZ': if (e.ctrlKey || e.metaKey) { own(); this.undo(); } return;
    }
    const d = this.trains.driven;
    if (d && ['ArrowUp', 'ArrowDown', 'ArrowLeft'].includes(e.code)) {
      own();
      const t = d.t;
      t.mode = 'speed';
      t.kmph = e.code === 'ArrowLeft' ? 0 : Math.max(0, Math.min(d.loco.maxSpeedKmph, t.kmph + (e.code === 'ArrowUp' ? 5 : -5)));
      this.toast(`${d.name}: ${t.kmph} km/h`);
      return;
    }
    // Ctrl + a drone key: the browser's shortcuts (save, bookmark...) are not wanted while flying
    if ((e.ctrlKey || e.metaKey) && ['KeyS', 'KeyD', 'KeyA', 'KeyQ', 'KeyE'].includes(e.code)) e.preventDefault();
  };

  private onUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };

  private onDown = (e: PointerEvent) => { if (e.button === 0) this.down = { x: e.clientX, y: e.clientY }; };
  private onUp = (e: PointerEvent) => {
    const d = this.down;
    this.down = null;
    if (!d || e.button !== 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || this.menus.open) return;
    this.click(e.clientX, e.clientY);
  };

  /** A click in the world: the point being picked, or a train to select. */
  private click(cx: number, cy: number) {
    const h = this.h, r = h.canvas.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), h.rcam);
    const origin = this.raycaster.ray.origin.clone().add(h.origin), dir = this.raycaster.ray.direction.clone();
    if (this.picking) {
      const hit = this.trackHit(origin, dir);
      if (!hit) { this.toast('Click on (or right next to) the track', true); return; }
      const p = this.picking;
      this.endPick();
      p.cb(hit);
      return;
    }
    if (!this.ui) return;
    const t = this.trains.trainAt(origin, dir);
    if (t) { this.trains.select(t); this.toast(`Selected: ${this.trains.info(t).name}`); if (this.tab !== 'trains' && this.menuOpen) this.showTab('trains'); }
  }

  /** Where a ray meets the ground, as a point on the nearest track (km, line). */
  private trackHit(origin: THREE.Vector3, dir: THREE.Vector3): TrackHit | null {
    const h = this.h, f = h.field;
    let t = 0, prev = 0, hitT = -1;
    const above = (s: number) => origin.y + dir.y * s - f.height(origin.x + dir.x * s, origin.z + dir.z * s);
    while (t < 5000) {
      if (above(t) < 0) { hitT = t; break; }
      prev = t;
      t += Math.max(1, t * 0.01);
    }
    if (hitT < 0) return null;
    let a = prev, b = hitT;
    for (let i = 0; i < 12; i++) { const m = (a + b) / 2; if (above(m) < 0) b = m; else a = m; }
    const p = origin.clone().addScaledVector(dir, b);
    const n = f.nearest(p.x, p.z, 40);
    if (!n) return null;
    // the line clicked: the nearest of the lines there
    const main = h.route, fr = { x: 0, y: 0, z: 0, heading: 0 } as Parameters<typeof main.alignment.sample>[1];
    let line: string | null = null, bd = Infinity;
    for (const l of main.graph.lines) {
      if (n.km < l.fromKm || n.km > l.toKm) continue;
      main.alignment.sampleOffset(n.km * 1000, l.offset, fr);
      const d = Math.hypot(fr.x - p.x, fr.z - p.z);
      if (d < bd) { bd = d; line = l.id; }
    }
    return { km: n.km, x: p.x, y: p.y, z: p.z, line };
  }

  // ------------------------------------------------------------------ driving, undo
  /** "Drive this train": your own with the game's keys in the cab; a spawned one with the arrow keys from its cab camera. */
  private drive(r: TrainRef) {
    const h = this.h;
    this.cams.manual();
    this.cams.follow = r;
    if (r.kind === 'player') {
      this.trains.driven = null;
      h.rec.playerDrive = null;
      h.setKeyboardDriving(true);
      h.cameras.select(0, h.cameraContext(0.016));
      this.toast('Driving your train with the usual keys (Space still freezes here; the horn is in the train card)');
    } else if (r.kind === 'spawned') {
      h.setKeyboardDriving(false);
      this.trains.driven = r.s;
      r.s.t.mode = 'speed';
      this.cams.attach.setPreset(PRESETS.find(p => p.id === 'cab')!);
      this.cams.use('attach');
      this.toast(`Driving ${r.s.name}: Up / Down arrows +/- 5 km/h, Left arrow stops`);
    }
    this.trains.render();
  }

  private undo() {
    const u = this.undos.pop();
    if (!u) { this.toast('Nothing to undo'); return; }
    u.undo();
    this.toast(`Undone: ${u.label}`);
    this.trains.render();
  }

  // ------------------------------------------------------------------ the game's calls
  sim(dt: number) { this.trains.sim(dt); }

  frame(dt: number, wdt: number) {
    this.trains.frame(dt, wdt);
    this.cams.frame(dt);
    const low = this.settings.frame(dt);
    const badge = this.panel.querySelector<HTMLElement>('.rec-fps')!;
    badge.hidden = low === null;
    if (low !== null) badge.textContent = `${low} FPS`;
  }

  afterCamera() { this.film.afterCamera(); }
  afterRender() { this.cams.afterRender(); }

  /** The game was resumed from its pause menu: Record Mode's sound and screen as they were. */
  resumed() {
    const a = this.h.audio;
    if (a) { a.fadeIn(this.settings.s.mute ? 0 : this.settings.s.master); if (this.isFrozen) setTimeout(() => { if (this.isFrozen) a.ctx.suspend().catch(() => {}); }, 300); }
    this.settings.applyAudio();
    this.h.setGameUi(false);
    this.layout();
  }

  /** Leave Record Mode: ask whether the spawned trains stay as AI traffic. */
  askExit() {
    const h = this.h, wasPaused = h.paused();
    const back = () => { if (wasPaused) h.pauseMenu(); else this.menus.hide(); };
    const n = this.trains.list.length, studio = h.player.hidden();
    const el = document.createElement('div');
    el.className = 'menu confirm';
    el.innerHTML = `<h2>Exit Record Mode</h2>
      <p>${studio ? 'Drive a train of your own from here (a light engine at the station you chose), or go back to the main menu. Save the scene first if you want it again.' : ''}
      ${n ? ` Keep the ${n} spawned train${n > 1 ? 's' : ''} as AI traffic? They drive on by themselves, obeying signals and speed limits.` : studio ? '' : 'Back to normal driving.'}</p>
      <div class="buttons">${n ? '<button data-e="keep">Drive, keep the trains</button><button data-e="drop">Drive, remove them</button>' : '<button data-e="drop">Drive</button>'}
      ${studio ? '<button data-e="menu">Main menu</button>' : ''}<button data-e="cancel">Cancel</button></div>`;
    el.addEventListener('click', e => {
      const a = (e.target as HTMLElement).closest('button')?.dataset.e;
      if (a === 'cancel') back();
      if (a === 'menu') h.quit();
      if (a === 'keep' || a === 'drop') { this.exit(a === 'keep'); if (wasPaused) h.resume(); else this.menus.hide(); }
    });
    this.menus.panel(el, back);
  }

  private exit(keep: boolean) {
    const h = this.h;
    if (this.isFrozen) this.freeze(false);
    removeEventListener('keydown', this.onKey, true);
    removeEventListener('beforeunload', this.onUnload);
    h.canvas.removeEventListener('pointerdown', this.onDown);
    removeEventListener('pointerup', this.onUp);
    for (const el of [this.panel, this.showBtn, this.toasts, this.hint, this.help, this.banner]) el.remove();
    document.body.classList.remove('rec-on', 'rec-clean', 'rec-picking');
    this.film.dispose();
    this.cams.dispose();
    this.world.reset();
    this.settings.reset();
    h.audio?.setRate(1);
    h.exit();
    this.trains.followed = null;
    // your own train back (studio from the main menu): anything spawned on top of it goes
    if (h.player.hidden()) {
      const r = h.player.route(), head = h.player.headKm(), tail = head - h.player.consist.length / 1000;
      for (const s of [...this.trains.list]) {
        const t = s.t, k = r.viewKm(t.route.canonicalKm(t.headKm)), kt = r.viewKm(t.route.canonicalKm(t.tailKm));
        const lo = Math.min(k, kt), hi = Math.max(k, kt);
        if (hi > tail - 0.05 && lo < head + 0.05 && Math.abs((t.route.mirrored !== r.mirrored ? -1 : 1) * t.offsetAt(t.headKm) - h.player.offsetAt(head)) < 1.5) this.trains.remove(s);
      }
      h.player.setHidden(false);
      h.cameras.select(4, h.cameraContext(0.016));
    }
    if (keep && this.trains.list.length) {
      for (const s of this.trains.list) { s.t.obeySignals = s.t.obeyLimits = true; s.t.held = false; s.t.delay = 0; if (s.t.mode === 'parked') s.t.mode = 'auto'; }
      this.trains.detach();
      h.keep(this.trains);
    } else {
      this.trains.dispose();
      h.keep(null);
    }
    h.setGameUi(true);
    bus.emit('message', { text: keep && this.trains.list.length ? `Record Mode closed: ${this.trains.list.length} trains run on as AI traffic` : 'Record Mode closed', kind: 'info', ms: 4000 });
  }
}
