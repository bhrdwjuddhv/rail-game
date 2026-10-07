import { WEATHER, WeatherId } from '../environment/Weather';
import type { GodMode, GodSettings } from '../gameplay/GodMode';
import type { StationInfo } from '@rail/shared/track/Route';

export interface GodPanelHooks {
  stations: StationInfo[];
  routeLengthKm: number;
  freeRoam: boolean;
  getHours(): number;
  setHours(h: number): void;
  setWeather(id: WeatherId): void;
  currentWeather(): WeatherId;
  teleport(target: { station?: string; km?: number; line?: string }): void;
  /** running lines (double line: UP, DOWN) and the one the train is on */
  lines: string[];
  currentLine: string;
  back(): void;
  resume(): void;
  /** debug scene with every texture (Texture Test) */
  textureTest(): void;
  /** fixed views of reported visual bugs on this route */
  bugCameras: { id: string; label: string }[];
  bugCamera(id: string): void;
}

type BoolKey = { [K in keyof GodSettings]: GodSettings[K] extends boolean ? K : never }[keyof GodSettings];

const SECTIONS: { title: string; toggles: [BoolKey, string, string][] }[] = [
  {
    title: 'Signals & rules',
    toggles: [
      ['obeySignals', 'Obey signals', 'Off: red signals neither stop nor penalise the train'],
      ['autoStopAtRed', 'Auto-stop at red signals', 'The train brakes itself before a red signal'],
      ['forceGreen', 'Force all signals green', ''],
      ['spadPenalty', 'SPAD penalty', 'Passing a red signal ends a scenario'],
      ['speedEnforcement', 'Speed limit enforcement', 'Overspeed penalties'],
      ['mustStop', 'Must stop at stations', 'Missed booked stops are penalised'],
      ['vigilance', 'Vigilance control (dead-man)', ''],
    ],
  },
  {
    title: 'Train',
    toggles: [
      ['unlimitedSpeed', 'Unlimited speed', "Ignore the loco's maximum speed"],
      ['instantBrakes', 'Instant brakes', 'No air-brake build-up or release delay'],
      ['noWheelSlip', 'No wheel slip', ''],
      ['infiniteAir', 'Infinite brake air', 'Main reservoir never runs low'],
      ['autoDrive', 'Auto-drive', 'Follows limits, signals and booked stops by itself'],
    ],
  },
];

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** The God Mode screen (opened from the pause menu). Every control applies immediately. */
export function godModePanel(god: GodMode, h: GodPanelHooks): HTMLElement {
  const el = document.createElement('div');
  el.className = 'menu god';
  const s = god.settings;
  const tog = (k: BoolKey, label: string, hint: string) =>
    `<label class="tog" title="${esc(hint)}"><input type="checkbox" data-g="${k}" ${s[k] ? 'checked' : ''}><span>${esc(label)}</span>${hint ? `<small>${esc(hint)}</small>` : ''}</label>`;
  const hours = h.getHours();
  el.innerHTML = `
    <h2>&#9889; God Mode</h2>
    <label class="tog master"><input type="checkbox" data-g="active" ${god.active ? 'checked' : ''}><span>Activate God Mode</span></label>
    <p class="note warn" data-k="scoring" ${god.usedThisRun ? '' : 'hidden'}>Scoring and achievements are disabled for this run.</p>
    <div class="cols god-sections ${god.active ? '' : 'off'}">
      ${SECTIONS.map(sec => `<section><h3>${sec.title}</h3>${sec.toggles.map(([k, l, hint]) => tog(k, l, hint)).join('')}
        ${sec.title === 'Train' ? `
        <label>Power <input type="range" min="0.5" max="5" step="0.1" value="${s.powerMultiplier}" data-n="powerMultiplier"><output>${s.powerMultiplier.toFixed(1)}&times;</output></label>
        <label>Train mass <input type="range" min="0.25" max="3" step="0.05" value="${s.massMultiplier}" data-n="massMultiplier"><output>${s.massMultiplier.toFixed(2)}&times;</output></label>` : ''}
      </section>`).join('')}
      <section><h3>World</h3>
        <label>Time of day <input type="range" min="0" max="23.99" step="0.05" value="${hours.toFixed(2)}" data-w="hours"><output>${fmtH(hours)}</output></label>
        ${tog('freezeTime', 'Freeze time', '')}
        <label>Time speed <input type="range" min="1" max="10" step="1" value="${s.timeSpeed}" data-n="timeSpeed"><output>${s.timeSpeed}&times;</output></label>
        <label>Weather <select data-w="weather">${(Object.keys(WEATHER) as WeatherId[]).map(w => `<option value="${w}" ${w === h.currentWeather() ? 'selected' : ''}>${WEATHER[w].name}</option>`).join('')}</select></label>
        <h3>Teleport</h3>
        <label>Station <select data-t="station"><option value="">&mdash;</option>${h.stations.map(st => `<option value="${st.code}">${esc(st.name)} (km ${st.km})</option>`).join('')}</select></label>
        ${h.lines.length > 1 ? `<label>Line <select data-t="line">${h.lines.map(l => `<option value="${l}" ${l === h.currentLine ? 'selected' : ''}>${l} line (${l === 'DOWN' ? 'km increasing' : 'km decreasing'})</option>`).join('')}</select></label>` : ''}
        <label>or km <input type="number" min="0.5" max="${(h.routeLengthKm - 0.5).toFixed(1)}" step="0.1" data-t="km" placeholder="e.g. 26.6"></label>
        <div class="buttons left"><button data-a="teleport">Teleport train</button></div>
      </section>
      <section><h3>Camera</h3>
        ${tog('unlockFreeCamera', 'Unlock free camera range', 'Fly anywhere, no distance limit from the train')}
        ${tog('hideHud', 'Hide HUD (screenshots)', 'Esc still opens the menu')}
        <h3>Debug</h3>
        <div class="buttons left"><button data-a="texture-test" title="Every texture at real size, UV / mip / seam views, source list">Texture Test</button></div>
        ${h.bugCameras.length ? `<label>Bug check cameras <select data-t="bugcam">${h.bugCameras.map(c => `<option value="${c.id}">${esc(c.label)}</option>`).join('')}</select></label>
        <div class="buttons left"><button data-a="bugcam">Go to view</button></div>` : ''}
      </section>
    </div>
    ${h.freeRoam ? `<label class="tog"><input type="checkbox" data-g="remember" ${god.remember ? 'checked' : ''}><span>Remember for Free Roam</span></label>` : ''}
    <div class="buttons"><button data-a="back">Back</button><button data-a="resume">Resume</button></div>`;

  const sections = el.querySelector<HTMLElement>('.god-sections')!;
  const scoringNote = el.querySelector<HTMLElement>('[data-k="scoring"]')!;
  el.addEventListener('change', e => {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    const g = (t as HTMLElement).dataset.g;
    if (g === 'active') {
      god.setActive((t as HTMLInputElement).checked);
      sections.classList.toggle('off', !god.active);
      scoringNote.hidden = !god.usedThisRun;
    } else if (g === 'remember') god.setRemember((t as HTMLInputElement).checked);
    else if (g) god.set(g as BoolKey, (t as HTMLInputElement).checked);
    if ((t as HTMLElement).dataset.w === 'weather') { god.set('weather', t.value as WeatherId); h.setWeather(t.value as WeatherId); }
  });
  el.addEventListener('input', e => {
    const t = e.target as HTMLInputElement;
    const out = t.nextElementSibling as HTMLOutputElement | null;
    const n = t.dataset.n as 'powerMultiplier' | 'massMultiplier' | 'timeSpeed' | undefined;
    if (n) {
      god.set(n, Number(t.value));
      if (out) out.textContent = n === 'timeSpeed' ? `${t.value}×` : `${Number(t.value).toFixed(n === 'massMultiplier' ? 2 : 1)}×`;
    }
    if (t.dataset.w === 'hours') { h.setHours(Number(t.value)); if (out) out.textContent = fmtH(Number(t.value)); }
  });
  el.addEventListener('click', e => {
    const a = (e.target as HTMLElement).closest('button')?.dataset.a;
    if (a === 'back') h.back();
    if (a === 'resume') h.resume();
    if (a === 'texture-test') h.textureTest();
    if (a === 'bugcam') h.bugCamera((el.querySelector('[data-t="bugcam"]') as HTMLSelectElement).value);
    if (a === 'teleport') {
      const station = (el.querySelector('[data-t="station"]') as HTMLSelectElement).value;
      const km = Number((el.querySelector('[data-t="km"]') as HTMLInputElement).value);
      const line = (el.querySelector('[data-t="line"]') as HTMLSelectElement | null)?.value ?? h.currentLine;
      if (station) h.teleport({ station, line });
      else if (km > 0) h.teleport({ km: Math.min(h.routeLengthKm - 0.5, Math.max(0.5, km)), line });
      else if (line !== h.currentLine) h.teleport({ line });
    }
  });
  return el;
}

const fmtH = (h: number) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;
