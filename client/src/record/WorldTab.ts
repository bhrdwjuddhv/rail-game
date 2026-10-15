import * as THREE from 'three/webgpu';
import { WEATHER, WeatherId } from '../environment/Weather';
import { oheShow, wireMaterial } from '../infrastructure/OHE';
import { TRAFFIC_LEVELS, settings } from '../core/Settings';
import { newFrame } from '@rail/shared/track/Chainage';
import type { Flat } from '@rail/shared/record/SceneFile';
import type { Studio } from './host';
import type { RecordTrains } from './RecordTrains';

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const fmtH = (h: number) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;

const DEFAULTS = {
  timeFrozen: false, timeSpeed: 1, sunAngle: 0,
  rain: -1, fog: 1, wind: -1, clouds: -1,
  forceGreen: false, traffic: -2, crowds: true, crowdAmount: 1, billboards: true,
  hideWires: false, hideMasts: false, hideSignals: false, hidePeople: false, hideRoad: false, beam: 1, glow: 1,
};
type WorldSettings = typeof DEFAULTS;

/**
 * The World tab: God Mode's world tools for filming. Time (and freezing the
 * clock), sun direction, weather with fine control, signals, teleports,
 * traffic density, crowds, billboards, and hiding wires / signals / people /
 * road vehicles. Everything is undone when Record Mode closes.
 */
export class WorldTab {
  s: WorldSettings = { ...DEFAULTS };
  readonly el = document.createElement('div');
  /** put the drone camera somewhere (set by the studio) */
  placeCamera: ((pos: THREE.Vector3, look: THREE.Vector3) => void) | null = null;

  constructor(private st: Studio, private trains: RecordTrains) {
    this.el.className = 'rec-world';
    this.render();
  }

  /** Push the settings into the game. */
  apply() {
    const h = this.st.h, s = this.s, rec = h.rec;
    rec.timeScale = s.timeFrozen ? 0 : s.timeSpeed;
    h.time.azimuth = (s.sunAngle * Math.PI) / 180;
    const o = h.weather.override;
    o.rain = s.rain >= 0 ? s.rain : undefined;
    o.wind = s.wind >= 0 ? s.wind : undefined;
    o.cloud = s.clouds >= 0 ? s.clouds : undefined;
    o.fog = s.fog !== 1 ? s.fog : undefined;
    rec.forceGreen = s.forceGreen;
    const traffic = s.traffic === -2 ? null : s.traffic;
    if (traffic !== rec.traffic) { rec.traffic = traffic; h.restartTraffic(); }
    const people = h.people();
    if (people) people.amount = s.crowdAmount;
    h.stationCrowds(s.crowds && !s.hidePeople);
    h.billboards.visible = s.billboards;
    wireMaterial.visible = !s.hideWires;
    if (oheShow.masts === s.hideMasts) { oheShow.masts = !s.hideMasts; h.rebuildLineside(); }
    rec.hideSignals = s.hideSignals;
    h.roadTraffic.visible = !s.hideRoad;
    rec.beam = s.beam; rec.glow = s.glow;
    h.requestRender();
  }

  /** Leaving Record Mode: the world as the game had it. */
  reset() {
    const h = this.st.h;
    h.time.azimuth = 0;
    for (const k of ['rain', 'wind', 'cloud', 'fog'] as const) delete h.weather.override[k];
    const people = h.people();
    if (people) people.amount = 1;
    h.stationCrowds(true);
    h.billboards.visible = true;
    wireMaterial.visible = true;
    if (!oheShow.masts) { oheShow.masts = true; h.rebuildLineside(); }
    h.roadTraffic.visible = true;
  }

  toScene(): Flat { return { ...this.s, hours: this.st.h.time.hours, weather: this.st.h.weather.id }; }
  fromScene(f: Flat) {
    const s: Record<string, unknown> = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS) as (keyof WorldSettings)[]) if (typeof f[k] === typeof DEFAULTS[k]) s[k] = f[k];
    this.s = s as WorldSettings;
    if (typeof f.weather === 'string' && f.weather in WEATHER) this.st.h.setWeather(f.weather as WeatherId);
    if (typeof f.hours === 'number') this.st.h.setHours(Math.max(0, Math.min(23.99, f.hours)));
    this.apply();
    this.render();
  }

  /** The drone over a station, looking at it. */
  cameraTo(code: string) {
    const h = this.st.h, st = h.route.station(code);
    if (!st) return;
    const f = newFrame();
    h.route.alignment.sampleOffset(st.km * 1000 - 120, -35, f);
    const pos = new THREE.Vector3(f.x, h.field.height(f.x, f.z) + 18, f.z);
    h.route.alignment.sample(st.km * 1000, f);
    this.placeCamera?.(pos, new THREE.Vector3(f.x, f.y + 3, f.z));
  }

  render() {
    const h = this.st.h, s = this.s, w = h.weather;
    const sl = (k: keyof WorldSettings, label: string, min: number, max: number, step: number, fmt: (v: number) => string) =>
      `<label>${label} <input type="range" min="${min}" max="${max}" step="${step}" value="${s[k]}" data-w="${k}"><output>${fmt(s[k] as number)}</output></label>`;
    const tog = (k: keyof WorldSettings, label: string, hint = '') => `<label class="tog"><input type="checkbox" data-w="${k}" ${s[k] ? 'checked' : ''}><span>${label}</span>${hint ? `<small>${hint}</small>` : ''}</label>`;
    const auto = (v: number) => (v < 0 ? 'preset' : v.toFixed(2));
    const sel = this.trains.selected;
    const selName = sel && sel.kind === 'spawned' ? sel.s.name : null;
    this.el.innerHTML = `
      <details open><summary>Time</summary>
        <label>Time of day <input type="range" min="0" max="23.99" step="0.05" value="${h.time.hours.toFixed(2)}" data-wh="hours"><output>${fmtH(h.time.hours)}</output></label>
        ${tog('timeFrozen', 'Freeze the clock', 'the sun stays put while trains run')}
        ${sl('timeSpeed', 'Clock speed', 0, 120, 1, v => `${v}&times;`)}
        ${sl('sunAngle', 'Sun angle', -180, 180, 1, v => `${v}&deg;`)}</details>
      <details open><summary>Weather</summary>
        <label>Weather <select data-wh="weather">${(Object.keys(WEATHER) as WeatherId[]).map(id => `<option value="${id}" ${id === w.id ? 'selected' : ''}>${WEATHER[id].name}</option>`).join('')}</select></label>
        ${sl('rain', 'Rain', -0.05, 1, 0.05, auto)}${sl('fog', 'Fog thickness', 0, 4, 0.05, v => `${v.toFixed(2)}&times;`)}
        ${sl('wind', 'Wind', -0.05, 3, 0.05, auto)}${sl('clouds', 'Clouds', -0.05, 1, 0.05, auto)}
        <p class="note">Far left = as the weather preset has it.</p></details>
      <details open><summary>Signals and traffic</summary>
        ${tog('forceGreen', 'Force every signal green', 'trains still keep clear of each other')}
        <div class="buttons left"><button data-wa="obey-on">All spawned: obey signals and limits</button><button data-wa="obey-off">All spawned: ignore them</button></div>
        <label>AI traffic <select data-w="traffic"><option value="-2" ${s.traffic === -2 ? 'selected' : ''}>As in Settings (${TRAFFIC_LEVELS[settings.get().traffic]?.name ?? 'Medium'})</option><option value="-1" ${s.traffic === -1 ? 'selected' : ''}>Off</option>${TRAFFIC_LEVELS.map((l, i) => `<option value="${i}" ${s.traffic === i ? 'selected' : ''}>${l.name}</option>`).join('')}</select></label></details>
      <details><summary>Teleport</summary>
        <label>Station <select data-wh="station">${h.route.stations.map(x => `<option value="${x.code}">${esc(x.name)}</option>`).join('')}</select></label>
        <div class="buttons left"><button data-wa="tp-camera">Camera there</button>${h.player.hidden() ? '' : '<button data-wa="tp-player">Your train there</button>'}${selName ? `<button data-wa="tp-selected">${esc(selName)} there</button>` : ''}</div></details>
      <details open><summary>People, billboards, clutter</summary>
        ${tog('crowds', 'Platform crowds')}${sl('crowdAmount', 'Crowd size', 0, 1, 0.05, v => `${Math.round(v * 100)}%`)}
        ${tog('billboards', 'Billboards')}
        ${tog('hideWires', 'Hide overhead wires')}${tog('hideMasts', 'Hide overhead wire masts and portals')}${tog('hideSignals', 'Hide signals')}${tog('hidePeople', 'Hide people')}${tog('hideRoad', 'Hide road vehicles')}</details>
      <details><summary>Lights</summary>
        ${sl('beam', 'Headlight beam', 0, 3, 0.05, v => `${v.toFixed(2)}&times;`)}${sl('glow', 'Fog glow (bloom)', 0, 3, 0.05, v => `${v.toFixed(2)}&times;`)}</details>
      <div class="buttons left"><button data-wa="reset">Reset world settings</button></div>`;
  }

  bind() {
    const set = (t: HTMLInputElement, done: boolean) => {
      const h = this.st.h, k = t.dataset.w as keyof WorldSettings | undefined, out = t.nextElementSibling as HTMLOutputElement | null;
      if (t.dataset.wh === 'hours') { h.setHours(Number(t.value)); if (out) out.textContent = fmtH(Number(t.value)); h.requestRender(); return; }
      if (t.dataset.wh === 'weather' && done) { h.setWeather(t.value as WeatherId); return; }
      if (!k) return;
      const v = t.type === 'checkbox' ? t.checked : Number(t.value);
      (this.s as Record<string, unknown>)[k] = v;
      if (out && typeof v === 'number') out.textContent = k === 'timeSpeed' ? `${v}×` : k === 'sunAngle' ? `${v}°` : k === 'crowdAmount' ? `${Math.round(v * 100)}%` : ['rain', 'wind', 'clouds'].includes(k) ? (v < 0 ? 'preset' : v.toFixed(2)) : `${v.toFixed(2)}×`;
      this.apply();
    };
    this.el.addEventListener('input', e => set(e.target as HTMLInputElement, false));
    this.el.addEventListener('change', e => set(e.target as HTMLInputElement, true));
    this.el.addEventListener('click', e => {
      const a = (e.target as HTMLElement).closest('button')?.dataset.wa;
      if (!a) return;
      const h = this.st.h, code = (this.el.querySelector('[data-wh="station"]') as HTMLSelectElement | null)?.value ?? '';
      if (a === 'obey-on' || a === 'obey-off') { for (const s of this.trains.list) this.st.apply(() => { s.t.obeySignals = s.t.obeyLimits = a === 'obey-on'; }); this.st.toast(a === 'obey-on' ? 'Spawned trains obey signals and limits' : 'Spawned trains ignore signals and limits (they still never run into each other)'); }
      if (a === 'tp-camera') this.cameraTo(code);
      if (a === 'tp-player') void h.player.teleport({ station: code });
      if (a === 'tp-selected') { const sel = this.trains.selected; if (sel?.kind === 'spawned') this.trains.moveTo(sel.s, code); }
      if (a === 'reset') { this.s = { ...DEFAULTS }; this.apply(); this.render(); }
    });
  }
}
