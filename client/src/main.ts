import { TrainDynamics } from '@rail/shared/physics/TrainDynamics';
TrainDynamics.strictNaN = import.meta.env.DEV;
import './style.css';
import './touch.css';
import { AudioEngine } from './audio/AudioEngine';
import { assets } from './core/AssetRegistry';
import { textures } from './core/TextureLibrary';
import { RendererKind, RenderSystem } from './core/Renderer';
import { applyMobileDefaults, applyPreset, PRESETS, settings } from './core/Settings';
import { enterGameScreen, isTouch, lockControlMode } from './input/Device';
import { RotateScreen } from './ui/RotateScreen';
import { setMaxAnisotropy } from './core/Textures';
import { SCENARIOS } from './data';
import { Game } from './Game';
import type { ScenarioOverrides } from '@rail/shared/gameplay/Scenario';
import type { BenchConfig, BenchView } from './core/Benchmark';
import type { Quality } from './core/Settings';
import { Menus } from './ui/Menus';
import { setVegetationRenderer } from './world/scenery/Vegetation';
import { initModelLoader } from './train/LocoModelLoader';

const app = document.getElementById('app')!;
const ui = document.getElementById('ui')!;

/** One-shot key capture for rebinding (works with or without a running game). */
function captureKey(cb: (code: string) => void) {
  const h = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    removeEventListener('keydown', h, true);
    cb(e.code);
  };
  addEventListener('keydown', h, true);
}

const params = new URLSearchParams(location.search);
const benchView = params.get('bench') as BenchView | null;
const benchCfg: BenchConfig | undefined = benchView ? { view: benchView, seconds: Number(params.get('seconds') ?? 60), warmup: 6, speedKmph: 80 } : undefined;
function applyUrlOverrides() {
  if (params.get('quality')) applyPreset(params.get('quality') as Quality);
  if (params.get('shadows')) settings.set({ shadows: params.get('shadows') as 'off' | 'low' | 'high' });
  if (params.get('scale')) settings.set({ renderScale: Number(params.get('scale')) });
  if (params.get('bloom')) settings.set({ bloom: params.get('bloom') === '1' });
  if (params.get('draw')) settings.set({ drawDistance: Number(params.get('draw')) });
}

async function boot() {
  const menus = new Menus(ui, { start: (id, o, opts) => start(id, o, false, opts), captureKey });
  let rs: RenderSystem;
  try {
    const kind = (params.get('renderer') && params.get('renderer') !== 'auto' ? params.get('renderer') : settings.get().renderer) as RendererKind;
    rs = await RenderSystem.create(app, PRESETS[settings.get().quality].antialias, kind);
    rs.setMaxPixelRatio(settings.get().maxPixelRatio);
  } catch (e) {
    menus.error(`Could not start WebGPU or WebGL2 in this browser.\n${(e as Error).message}`);
    return;
  }
  if (!settings.get().autoDetected) {
    // phones and tablets start on Low or Medium with a low pixel ratio
    if (isTouch) applyMobileDefaults(rs.detectQuality()); else applyPreset(rs.detectQuality());
    settings.set({ autoDetected: true });
  }
  // URL overrides (benchmarks/diagnostics) are applied after auto-detection so they always win
  applyUrlOverrides();
  rs.setMaxPixelRatio(settings.get().maxPixelRatio);
  setMaxAnisotropy(8);
  await assets.init(rs.renderer);
  textures.init(rs.renderer);
  setVegetationRenderer(rs.renderer);
  initModelLoader(rs.renderer);
  rs.resize(innerWidth, innerHeight);
  document.body.dataset.backend = rs.backend;
  (window as any).__rail = { backend: rs.backend };

  // last-resort handlers: an uncaught error anywhere shows the friendly error screen
  const onFatal = (e: unknown) => {
    const game = (window as any).__rail?.game as Game | undefined;
    if (game) game.fail(e); else menus.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  };
  addEventListener('error', e => { if (e.error) onFatal(e.error); });
  addEventListener('unhandledrejection', e => onFatal(e.reason));

  let running = false;
  async function start(id: string, overrides: ScenarioOverrides, auto: boolean, opts: { tutorial?: boolean } = {}) {
    if (running) return;
    running = true;
    lockControlMode();
    if (!auto) enterGameScreen(); // still inside the Start tap
    const data = SCENARIOS[id];
    let audio: AudioEngine | null = null;
    try { audio = new AudioEngine(); } catch { /* no Web Audio: play silent */ }
    try {
      menus.loading('Building route', 0.02);
      await new Promise(r => setTimeout(r, 30));
      const game = new Game(rs, menus, ui, audio, data, overrides, id, benchCfg);
      (window as any).__rail.game = game;
      await game.load((t, p) => menus.loading(t, p));
      if (auto && !benchCfg) menus.clickToStart(() => game.begin(opts));
      else await game.begin(opts);
    } catch (e) {
      console.error(e);
      menus.error(String((e as Error).stack ?? e));
    }
  }

  // phones held upright: cover the screen and pause the run until rotated
  const rotate = new RotateScreen(document.body);
  rotate.onChange = portrait => { if (portrait) (window as any).__rail?.game?.pause(); };

  let auto: { id: string; overrides: ScenarioOverrides } | null = null;
  try { auto = JSON.parse(sessionStorage.getItem('railbharat.autostart') ?? 'null'); } catch { /* ignore */ }
  const q = params.get('scenario');
  if (q && SCENARIOS[q]) auto = { id: q, overrides: params.get('loco') ? { loco: params.get('loco')! } : {} };
  if (benchCfg) auto = { id: 'free-roam', overrides: { startStation: 'RNPJ', time: '12:00', weather: 'clear', timeScale: 1, consist: { loco: 'ep-7', coaches: [{ type: 'general', count: 6 }, { type: 'sleeper', count: 6 }], loaded: true } } };
  if (auto && SCENARIOS[auto.id]) start(auto.id, auto.overrides, true);
  else menus.main();
}

boot();
