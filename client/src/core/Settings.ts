import { isTouch } from '../input/Device';
import { safeStorageGet, safeStorageSet } from './storage';
import { Store } from './Store';

export type Quality = 'low' | 'medium' | 'high' | 'ultra';

export interface QualityPreset {
  renderScale: number;
  shadows: 'off' | 'low' | 'high';
  drawDistance: number;   // m, terrain + far plane
  sceneryRange: number;   // m, full scenery models
  impostorRange: number;  // m, billboard trees
  grassDensity: number;  // tufts per 8 m cell near the line (0 = off)
  grassRadius: number;   // m; grass fades out in the vertex shader before this
  bloom: boolean;
  antialias: boolean;
  terrainDetail: number;  // 1 = 4 m grid near the camera, 2 = 8 m
}

export const PRESETS: Record<Quality, QualityPreset> = {
  low:    { renderScale: 0.7, shadows: 'off',  drawDistance: 1800, sceneryRange: 260, impostorRange: 900,  grassDensity: 0, grassRadius: 0, bloom: false, antialias: false, terrainDetail: 2 },
  medium: { renderScale: 0.85, shadows: 'low', drawDistance: 2600, sceneryRange: 340, impostorRange: 1300, grassDensity: 0.6, grassRadius: 70, bloom: true,  antialias: true,  terrainDetail: 1 },
  high:   { renderScale: 1.0, shadows: 'high', drawDistance: 3400, sceneryRange: 420, impostorRange: 1800, grassDensity: 1.2, grassRadius: 110,  bloom: true,  antialias: true,  terrainDetail: 1 },
  ultra:  { renderScale: 1.0, shadows: 'high', drawDistance: 4500, sceneryRange: 650, impostorRange: 2400, grassDensity: 2, grassRadius: 150, bloom: true,  antialias: true,  terrainDetail: 1 },
};

export const ACTIONS = {
  throttleUp: 'Throttle up', throttleDown: 'Throttle down',
  regenUp: 'Regen brake up', regenDown: 'Regen brake down',
  trainBrakeApply: 'Train brake apply', trainBrakeRelease: 'Train brake release',
  locoBrakeApply: 'Loco brake apply', locoBrakeRelease: 'Loco brake release',
  emergency: 'Emergency brake', reverserFwd: 'Reverser forward', reverserBack: 'Reverser back',
  horn: 'Horn (Shift = high tone)', headlights: 'Headlights', wipers: 'Wipers', sander: 'Sander',
  vigilance: 'Vigilance acknowledge', pantograph: 'Pantograph', vcb: 'Main breaker (VCB)',
  cabLight: 'Cab light', markers: 'Marker lights', flasher: 'Flasher',
  fuelPump: 'Fuel pump (diesel)', engine: 'Engine start / stop (diesel)',
  doors: 'Doors open / close, start loading (at a stop)',
  routeAhead: 'Route ahead (Free Roam)', throwPoints: 'Throw next points (God Mode manual points)',
  hud: 'Toggle HUD', map: 'Toggle map', pause: 'Pause', perf: 'Performance overlay', help: 'Help',
  prevVehicle: 'Camera: previous vehicle', nextVehicle: 'Camera: next vehicle',
} as const;
export type Action = keyof typeof ACTIONS;

export const DEFAULT_KEYS: Record<Action, string> = {
  throttleUp: 'KeyD', throttleDown: 'KeyA', regenUp: 'KeyC', regenDown: 'KeyZ',
  trainBrakeApply: 'Quote', trainBrakeRelease: 'Semicolon',
  locoBrakeApply: 'BracketRight', locoBrakeRelease: 'BracketLeft',
  emergency: 'Backspace', reverserFwd: 'KeyW', reverserBack: 'KeyS',
  horn: 'Space', headlights: 'KeyL', wipers: 'KeyV', sander: 'KeyX', vigilance: 'KeyQ',
  pantograph: 'KeyP', vcb: 'KeyO', cabLight: 'KeyK', markers: 'KeyN', flasher: 'KeyB',
  fuelPump: 'KeyU', engine: 'KeyE',
  routeAhead: 'KeyG', throwPoints: 'KeyJ', doors: 'KeyT',
  hud: 'KeyH', map: 'KeyM', pause: 'Escape', perf: 'F3', help: 'F1',
  prevVehicle: 'Comma', nextVehicle: 'Period',
};

export interface SettingsData {
  quality: Quality;
  renderScale: number;
  shadows: QualityPreset['shadows'];
  drawDistance: number;
  bloom: boolean;
  fogMultiplier: number;
  volumes: { master: number; train: number; horn: number; env: number; ui: number };
  units: 'kmh' | 'mph';
  keys: Record<Action, string>;
  dayNightSpeed: number;
  mouseSensitivity: number;
  autoDetected: boolean;
  renderer: 'webgl' | 'webgpu' | 'webgpu-gl';
  maxPixelRatio: number;
  /** dynamic resolution: drop the render scale when frames run slow (AdaptiveResolution) */
  adaptiveQuality: boolean;
  /** touch devices: fade the on-screen controls after a few seconds without a touch */
  touchAutoHide: boolean;
  /** festival mode: string lights on the houses and diyas at the doors by night, kites over the towns by day */
  festival: boolean;
  /** touch devices: both levers on the right (default) or throttle on the left edge */
  leverLayout: 'right' | 'split';
  /**
   * driving controls: beginner (the loco ready to go at the start: engine running / pantograph up, brakes
   * released, reverser forward, no vigilance alarm) or advanced (the full start-up, as a real driver does it)
   */
  driving: 'beginner' | 'advanced';
  /** control layout: detect, or force touch / keyboard & mouse (applies from the next run) */
  controls: 'auto' | 'touch' | 'desktop';
  /** rail traffic: 0 low, 1 medium, 2 high, 3 very high (TRAFFIC_LEVELS) */
  traffic: number;
}

/**
 * Rail traffic levels: how often AI trains run on the other line (oncoming)
 * and on the player's own line (overtaking in station loops and on the middle
 * line). Multipliers of the route's base headway; null = no own-line traffic.
 * Low is the old amount (own-line trains in Free Roam only).
 */
export const TRAFFIC_LEVELS = [
  { name: 'Low', oncoming: 1, sameLine: 2, inScenarios: false },
  { name: 'Medium', oncoming: 0.6, sameLine: 1.2, inScenarios: true },
  { name: 'High', oncoming: 0.4, sameLine: 0.8, inScenarios: true },
  { name: 'Very high', oncoming: 0.25, sameLine: 0.5, inScenarios: true },
] as const;
export const trafficLevel = () => TRAFFIC_LEVELS[Math.max(0, Math.min(3, Math.round(settings.get().traffic ?? 1)))];

const KEY = 'railbharat.settings.v1';

const defaults = (): SettingsData => ({
  quality: 'high', renderScale: 1, shadows: 'high', drawDistance: 3400, bloom: true, fogMultiplier: 1,
  volumes: { master: 0.8, train: 0.9, horn: 0.8, env: 0.7, ui: 0.6 },
  units: 'kmh', keys: { ...DEFAULT_KEYS }, dayNightSpeed: 10, mouseSensitivity: 1, autoDetected: false, renderer: 'webgl', maxPixelRatio: 1.5, adaptiveQuality: true,
  touchAutoHide: true, leverLayout: 'right', controls: 'auto', traffic: 1, driving: 'advanced', festival: false,
});

export const settings = new Store<SettingsData>((() => {
  const s = safeStorageGet(KEY, defaults());
  s.keys = { ...DEFAULT_KEYS, ...s.keys };
  s.volumes = { ...defaults().volumes, ...s.volumes };
  s.traffic ??= 1; // saved before the setting existed: medium
  return s;
})());
settings.subscribe(s => safeStorageSet(KEY, s));

export function applyPreset(q: Quality) {
  const p = PRESETS[q];
  settings.set({ quality: q, renderScale: p.renderScale, shadows: p.shadows, drawDistance: p.drawDistance, bloom: p.bloom });
}

/**
 * Phones and tablets: whatever preset is chosen, keep grass, close scenery,
 * shadows and draw distance within what a mid-range phone GPU can hold at
 * 30 FPS (the user can still lower them further).
 */
const MOBILE_CAPS = { drawDistance: 2400, sceneryRange: 300, impostorRange: 1100, grassDensity: 0.5, grassRadius: 55 };

/** Record Mode's "highest quality": a preset for this session only (never saved) */
export const qualityOverride: { q: Quality | null } = { q: null };

/** Effective preset = chosen quality with user overrides (capped on touch devices). */
export function effective(): QualityPreset {
  const s = settings.get();
  const o = qualityOverride.q;
  const p = o ? { ...PRESETS[o] } : { ...PRESETS[s.quality], renderScale: s.renderScale, shadows: s.shadows, drawDistance: s.drawDistance, bloom: s.bloom };
  if (isTouch) {
    p.drawDistance = Math.min(p.drawDistance, MOBILE_CAPS.drawDistance);
    p.sceneryRange = Math.min(p.sceneryRange, MOBILE_CAPS.sceneryRange);
    p.impostorRange = Math.min(p.impostorRange, MOBILE_CAPS.impostorRange);
    p.grassDensity = Math.min(p.grassDensity, MOBILE_CAPS.grassDensity);
    p.grassRadius = Math.min(p.grassRadius, MOBILE_CAPS.grassRadius);
    if (p.shadows === 'high') p.shadows = 'low';
  }
  return p;
}

/** First run on a phone/tablet: always Low (most phones cannot hold 30 FPS on Medium); players can raise it. */
export function applyMobileDefaults(_detected: Quality) {
  const q: Quality = 'low';
  applyPreset(q);
  settings.set({ maxPixelRatio: q === 'low' ? 1 : 1.25, bloom: false, renderScale: q === 'low' ? 0.75 : 0.85 });
}

// ---- save data (best scores) ----
const SAVE = 'railbharat.save.v1';
export interface SaveData { best: Record<string, { score: number; grade: string; date: string }> }
export const loadSave = () => safeStorageGet<SaveData>(SAVE, { best: {} });
export function recordScore(id: string, score: number, grade: string) {
  const s = loadSave();
  if (!s.best[id] || s.best[id].score < score) s.best[id] = { score, grade, date: new Date().toISOString().slice(0, 10) };
  safeStorageSet(SAVE, s);
}
