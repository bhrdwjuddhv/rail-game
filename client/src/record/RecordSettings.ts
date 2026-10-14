import { qualityOverride } from '../core/Settings';
import { safeStorageGet, safeStorageSet } from '../core/storage';
import type { Flat } from '@rail/shared/record/SceneFile';
import type { Studio } from './host';

const KEY = 'railbharat.record.v1';
const SIZES: Record<string, { w: number; h: number } | null> = { fit: null, '1080': { w: 1920, h: 1080 }, '1440': { w: 2560, h: 1440 }, '2160': { w: 3840, h: 2160 } };
const MIX_KEYS = ['master', 'train', 'horn', 'env', 'station', 'ui'] as const;
const MIX_NAMES: Record<(typeof MIX_KEYS)[number], string> = { master: 'Master', train: 'Train', horn: 'Horns', env: 'Environment', station: 'Stations', ui: 'Cab / UI' };

const DEFAULTS = {
  quality: 'highest' as 'highest' | 'game', scale: 1, output: 'fit', fps: 60, hideCursor: true,
  master: 0.9, train: 0.9, horn: 0.8, env: 0.7, station: 0.7, ui: 0, mute: false, keepPitch: false, hearFrom: 'camera' as 'camera' | 'train',
};
type RecSettings = typeof DEFAULTS;

/**
 * Record Mode's Settings tab: picture quality, output size (a fixed canvas,
 * centred with black round it), FPS cap, the audio mixer. Remembered in this
 * browser (and in scenes); none of it touches the game's own settings.
 */
export class RecordSettings {
  s: RecSettings;
  readonly el = document.createElement('div');
  private fps = 60;
  /** where the world is heard from when "the followed train" is chosen (set by the studio) */
  trainEar: (() => import('three/webgpu').Vector3 | null) | null = null;

  constructor(private st: Studio) {
    this.s = { ...DEFAULTS, ...safeStorageGet<Partial<RecSettings>>(KEY, {}) };
    this.el.className = 'rec-settings';
    addEventListener('resize', this.fit);
    this.render();
  }

  /** Push into the game: quality, size, frame cap, mixer, hearing. */
  apply() {
    const h = this.st.h, s = this.s, rec = h.rec;
    qualityOverride.q = s.quality === 'highest' ? 'ultra' : null;
    rec.noAdaptive = s.quality === 'highest';
    rec.output = SIZES[s.output] ?? null;
    rec.renderScale = rec.output || s.scale === 1 ? null : s.scale;
    h.applySettings();
    h.resize();
    this.fit();
    h.setFpsCap(s.fps);
    this.applyAudio();
    rec.listener = s.hearFrom === 'train' ? () => this.trainEar?.() ?? h.cameras.camera.position : null;
    safeStorageSet(KEY, s);
  }

  /** The mixer (the game's Settings volumes come back when Record Mode closes). */
  applyAudio() {
    const s = this.s, m = s.mute ? 0 : 1;
    this.st.h.audio?.setVolumes({ master: s.master * m, train: s.train, horn: s.horn, env: s.env, station: s.station, ui: s.ui });
  }

  /** A fixed output size: the canvas at its own pixels, scaled down only if the window is smaller, centred on black. */
  private fit = () => {
    const c = this.st.h.canvas, o = this.st.h.rec.output;
    document.body.classList.toggle('rec-fixed', !!o);
    if (!o) { c.style.cssText = ''; return; }
    const dpr = devicePixelRatio || 1, k = Math.min(1, innerWidth / (o.w / dpr), innerHeight / (o.h / dpr));
    const w = (o.w / dpr) * k, hh = (o.h / dpr) * k;
    c.style.cssText = `position:fixed;width:${w}px;height:${hh}px;left:${(innerWidth - w) / 2}px;top:${(innerHeight - hh) / 2}px`;
  };

  /** Measured frame rate (the studio feeds it each frame); returns a warning when it is low. */
  frame(dt: number) {
    if (dt > 0) this.fps += (1 / dt - this.fps) * Math.min(1, dt * 2);
    const want = this.s.fps || 60;
    const el = this.el.querySelector('[data-k="fps"]');
    if (el) el.textContent = `${Math.round(this.fps)} FPS${this.fps < want * 0.8 ? ` - below ${want}: lower the output size, the quality or the number of trains` : ''}`;
    return this.fps < want * 0.8 ? Math.round(this.fps) : null;
  }

  toScene(): Flat { return { ...this.s }; }
  fromScene(f: Flat) {
    const s: Record<string, unknown> = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS) as (keyof RecSettings)[]) if (typeof f[k] === typeof DEFAULTS[k]) s[k] = f[k];
    if (!(String(s.output) in SIZES)) s.output = 'fit';
    this.s = s as RecSettings;
    this.apply();
    this.render();
  }

  render() {
    const s = this.s;
    const sel = (k: keyof RecSettings, label: string, opts: [string | number, string][]) => `<label>${label} <select data-r="${k}">${opts.map(([v, n]) => `<option value="${v}" ${String(s[k]) === String(v) ? 'selected' : ''}>${n}</option>`).join('')}</select></label>`;
    this.el.innerHTML = `
      <details open><summary>Picture</summary>
        ${sel('quality', 'Quality', [['highest', 'Highest (Ultra, no adaptive resolution)'], ['game', 'As in Settings']])}
        ${sel('output', 'Output size', [['fit', 'Fit the window'], ['1080', '1920 × 1080'], ['1440', '2560 × 1440'], ['2160', '3840 × 2160 (4K)']])}
        ${s.output === 'fit' ? sel('scale', 'Render scale', [[1, '1× (as Settings)'], [1.25, '1.25×'], [1.5, '1.5×'], [2, '2× (sharpest, slowest)']]) : '<p class="note">A fixed size renders exactly those pixels; the window shows it scaled to fit, black round it.</p>'}
        ${sel('fps', 'Frame rate cap', [[60, '60 FPS'], [30, '30 FPS'], [0, 'None (screen rate)']])}
        <p class="note" data-k="fps"></p>
        <label class="tog"><input type="checkbox" data-r="hideCursor" ${s.hideCursor ? 'checked' : ''}><span>Hide the cursor in clean view</span></label></details>
      <details open><summary>Sound</summary>
        ${MIX_KEYS.map(k => `<label>${MIX_NAMES[k]} <input type="range" min="0" max="1" step="0.05" value="${s[k]}" data-r="${k}"><output>${Math.round(s[k] * 100)}%</output></label>`).join('')}
        <label class="tog"><input type="checkbox" data-r="mute" ${s.mute ? 'checked' : ''}><span>Mute all</span></label>
        <label class="tog"><input type="checkbox" data-r="keepPitch" ${s.keepPitch ? 'checked' : ''}><span>Keep normal pitch in slow motion</span></label>
        ${sel('hearFrom', 'Hear from', [['camera', 'The camera'], ['train', 'The followed train']])}</details>`;
  }

  bind() {
    const set = (t: HTMLInputElement, done: boolean) => {
      const k = t.dataset.r as keyof RecSettings | undefined;
      if (!k) return;
      const v = t.type === 'checkbox' ? t.checked : t.type === 'range' || ['scale', 'fps'].includes(k) ? Number(t.value) : t.value;
      (this.s as Record<string, unknown>)[k] = v;
      const out = t.nextElementSibling as HTMLOutputElement | null;
      if (t.type === 'range' && out) out.textContent = `${Math.round((v as number) * 100)}%`;
      if ((MIX_KEYS as readonly string[]).includes(k) || k === 'mute') { this.applyAudio(); if (done) safeStorageSet(KEY, this.s); return; }
      if (k === 'keepPitch') { safeStorageSet(KEY, this.s); this.onPitch?.(); return; }
      if (!done && t.type === 'range') return;
      this.apply();
      if (k === 'output') this.render();
    };
    this.el.addEventListener('input', e => set(e.target as HTMLInputElement, false));
    this.el.addEventListener('change', e => set(e.target as HTMLInputElement, true));
  }
  /** the pitch option changed (the studio re-applies slow motion) */
  onPitch: (() => void) | null = null;

  /** Leaving Record Mode: window-sized canvas, no cap, the game's volumes. */
  reset() {
    removeEventListener('resize', this.fit);
    document.body.classList.remove('rec-fixed');
    this.st.h.canvas.style.cssText = '';
  }
}
