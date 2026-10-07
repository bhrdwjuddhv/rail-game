import * as THREE from 'three/webgpu';
import { AudioEngine } from './audio/AudioEngine';
import { Ambience } from './audio/Ambience';
import { OneShots } from './audio/synth/OneShots';
import { TrainAudio } from './audio/TrainAudio';
import { CameraContext, CameraManager } from './camera/CameraManager';
import { CabCamera } from './camera/modes/CabCamera';
import { ChaseCamera } from './camera/modes/ChaseCamera';
import { CinematicCamera } from './camera/modes/CinematicCamera';
import { FreeCamera } from './camera/modes/FreeCamera';
import { FrontCamera } from './camera/modes/FrontCamera';
import { RearCamera } from './camera/modes/RearCamera';
import { SideCamera } from './camera/modes/SideCamera';
import { Benchmark, BenchConfig } from './core/Benchmark';
import { Engine } from './core/Engine';
import { textures } from './core/TextureLibrary';
import { prof } from './core/Profiler';
import { bus } from '@rail/shared/events';
import type { RenderSystem } from './core/Renderer';
import { Action, effective, recordScore, settings } from './core/Settings';
import { formatClock, KMPH, parseClock } from '@rail/shared/util';
import { COACHES, LOCOS, locoOrDefault, REGIONS, ROUTES } from './data';
import { Lighting } from './environment/Lighting';
import { Sky } from './environment/Sky';
import { TimeOfDay } from './environment/TimeOfDay';
import { WEATHER, Weather } from './environment/Weather';
import { AITrain, AI_LOCO_LEN, AI_WAGON_LEN } from '@rail/shared/gameplay/AITrain';
import { Rules } from '@rail/shared/gameplay/Rules';
import { AutoDriver } from '@rail/shared/gameplay/AutoDriver';
import { GodMode } from './gameplay/GodMode';
import { Tutorial, TUTORIALS, TutorialState, tutorialPrefs } from './gameplay/Tutorial';
import { CabHighlight } from './train/cab/CabHighlight';
import { godModePanel } from './ui/GodModePanel';
import { TextureTest } from './ui/TextureTest';
import { RoofCover, underRoof } from './infrastructure/Station';
import { VigilancePopup } from './ui/VigilancePopup';
import { BUG_CAMERAS, TrackPoint } from './gameplay/BugCameras';
import { TutorialCard } from './ui/TutorialCard';
import { applyOverrides, ScenarioData, ScenarioOverrides, startHeadKm, startTrack } from '@rail/shared/gameplay/Scenario';
import { Scoring } from '@rail/shared/gameplay/Scoring';
import { planFromTimetable, StopPlan, WorkedTrain } from '@rail/shared/gameplay/Timetable';
import { buildBridge } from './infrastructure/Bridge';
import { buildLcRoad, buildParallelRoad, LevelCrossingView } from './infrastructure/LevelCrossing';
import { StationView } from './infrastructure/Station';
import { buildLinesideChunk } from './infrastructure/TracksideProps';
import { buildTunnel } from './infrastructure/Tunnel';
import { Gamepad } from './input/Gamepad';
import { enterGameScreen, iosFullscreenTip, isFullscreen, isTouch } from './input/Device';
import { ResumeScreen } from './ui/ResumeScreen';
import { TouchControls } from './ui/TouchControls';
import { Keyboard } from './input/Keyboard';
import { Mouse } from './input/Mouse';
import { LineControl, RailControl } from '@rail/shared/signalling/Control';
import { SignalView } from './signalling/SignalMeshBuilder';
import { Railway } from '@rail/shared/track/Railway';
import { DEFAULT_TRAFFIC, TrafficManager } from '@rail/shared/traffic/TrafficManager';
import { newFrame, RAIL_TOP } from '@rail/shared/track/Chainage';
import { formatGradient } from '@rail/shared/track/Gradient';
import { Route } from '@rail/shared/track/Route';
import { buildTrackChunk, CHUNK_M, SwitchView } from './track/TrackMeshBuilder';
import { TrackGraph, TrackPath, Ramp } from '@rail/shared/track/TrackGraph';
import { CabControls, CONTROL_NAMES } from './train/cab/CabControls';
import { CabModel, cabLayout } from './train/cab/CabModel';
import { TrainView } from './train/Coach';
import { Consist, Vehicle } from '@rail/shared/train/Consist';
import { LocoSystems } from '@rail/shared/train/LocoSystems';
import { BRAKE_POSITIONS } from '@rail/shared/physics/BrakeSystem';
import { TrainDynamics } from '@rail/shared/physics/TrainDynamics';
import { HUD } from './ui/HUD';
import type { Menus } from './ui/Menus';
import { Minimap } from './ui/Minimap';
import { PerfOverlay } from './ui/PerfOverlay';
import { TrackProfile } from './ui/TrackProfile';
import { ChunkManager } from './world/ChunkManager';
import { TerrainField } from './world/TerrainField';
import { Traffic } from './world/traffic/Traffic';
import { buildRivers, Waterfalls } from './world/Water';
import { propMaterials, wind } from './world/scenery/Props';

interface Streamed {
  center: THREE.Vector3; radius: number; build: () => THREE.Object3D; obj: THREE.Object3D | null; dispose?: () => void;
  /** texture materials this item uses: loaded a ring before it is built, released a ring after */
  materials: string[]; texHeld: boolean;
}
/** Textures load this far beyond the build distance (so they are ready before the object appears) and unload a bit further out. */
const TEX_PREFETCH_M = 1500, TEX_RELEASE_M = 2100;

const CAMERA_NAMES = ["Driver's cab", 'Front', 'Rear', 'Side', 'Chase', 'Cinematic', 'Free'];
const FREE_CAM_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'KeyF']);

/**
 * Composition root: builds every system for one run and drives the fixed-step
 * simulation and the render loop. Systems talk through the event bus; this
 * class only moves data between them each frame.
 */
export class Game {
  readonly scenario: ScenarioData;
  readonly railway: Railway;
  /** the surveyed (+km) view: the world (track, terrain, stations, structures) is built from it */
  readonly route: Route;
  /** the player's direction view: driving, signalling, physics and HUD run in its km */
  private line: Route;
  readonly field: TerrainField;
  readonly scene = new THREE.Scene();
  /** Floating origin: all world content lives under `world`, positioned at -origin. */
  readonly world = new THREE.Group();
  readonly origin = new THREE.Vector3();
  /** Camera actually rendered: true camera pose minus the origin (small numbers for the GPU). */
  readonly rcam = new THREE.PerspectiveCamera();
  readonly cameras: CameraManager;
  private engine: Engine;
  private chunks: ChunkManager;
  private time: TimeOfDay;
  private weather: Weather;
  private sky: Sky;
  private lighting: Lighting;

  // train
  private consist: Consist;
  private dyn: TrainDynamics;
  private sys: LocoSystems;
  private path: TrackPath;
  private trainView: TrainView;
  private cab: CabModel;
  private controls: CabControls;
  private player: WorkedTrain;
  private plan: Map<string, StopPlan>;

  // signalling & gameplay: one LineControl per running direction; the player's is `lc`
  private ctl: RailControl;
  private lc: LineControl;
  private get interlocking() { return this.lc.interlocking; }
  private get block() { return this.lc.block; }
  private get dispatcher() { return this.lc.dispatcher; }
  /** scenario AI trains and opposite-line traffic, each drawn in the view it runs in */
  private ai: { train: AITrain; view: TrainView; route: Route; carM: number; side?: number }[] = [];
  /** scheduled trains on the other line of a double track, coming toward the player */
  private oncoming: TrafficManager | null = null;
  /** cab buffeting from a passing train, 0..1 */
  private shake = 0;
  private rules: Rules;
  private scoring = new Scoring();

  // world objects
  private trackChunks = new Map<number, THREE.Object3D>();
  private chunkCentres: THREE.Vector3[] = [];
  private streamed: Streamed[] = [];
  private stations = new Map<string, StationView>();
  private signalViews = new Map<string, SignalView>();
  private switchViews: SwitchView[] = [];
  private lcs: LevelCrossingView[] = [];
  private traffic: Traffic;
  private waterfalls: Waterfalls;

  // ui & io
  private hud: HUD;
  // God Mode, driving aids, tutorial
  readonly god: GodMode;
  private autoDriver = new AutoDriver();
  private baseTimeScale = 1;
  private tutorial: Tutorial | null = null;
  private tutorialCard: TutorialCard | null = null;
  private tutorialPractice = false;
  private highlight = new CabHighlight();
  private hudPulse: HTMLElement | null = null;
  private tut = { horn: false, moved: false, underLimit: 0 };
  private cabCam = new CabCamera();
  private freeCam = new FreeCamera();
  private teleporting = false;
  private profile: TrackProfile;
  private minimap: Minimap;
  private perf: PerfOverlay;
  private keyboard: Keyboard;
  private mouse: Mouse;
  private gamepad = new Gamepad();
  /** on-screen controls on phones and tablets */
  private touch: TouchControls | null = null;
  private started = false;
  /** touch: "Tap to continue" after the tab comes back or fullscreen was left */
  private resumeScreen: ResumeScreen | null = null;
  private wasFullscreen = false;
  private raycaster = new THREE.Raycaster();
  private pressedControl: string | null = null;

  // audio
  private shots?: OneShots;
  private trainAudio?: TrainAudio;
  private ambience?: Ambience;

  // misc state
  private t = 0;
  private sigAcc = 0;
  private uiAcc = 0;
  private profAcc = 0;
  private mapAcc = 0;
  private streamAcc = 1;
  private prevSpeed = 0;
  private smoothJerk = 0;
  private jolt = 0;
  private joltCooldown = 0;
  private slipping = false;
  private lastBP = 5;
  private bpRate = 0;
  private announced = new Set<string>();
  private startClock: number;
  private ended = false;
  private offs: (() => void)[] = [];
  private bench: Benchmark | null;
  private lastInCab: boolean | null = null;
  /** diagnostics: ?hide=terrain,track,train,signals,sky,scenery,cab hides groups to bisect frame cost */
  private debugHide = new Set((new URLSearchParams(location.search).get('hide') ?? '').split(',').filter(Boolean));
  private pathOffset: (km: number) => number = () => 0;
  private aheadRamps: Ramp[] = [];

  constructor(private rs: RenderSystem, private menus: Menus, private ui: HTMLElement, private audio: AudioEngine | null, scenario: ScenarioData, overrides: ScenarioOverrides, readonly scenarioId: string, benchCfg?: BenchConfig) {
    this.bench = benchCfg ? new Benchmark(benchCfg, rs) : null;
    const routeData = ROUTES[scenario.route];
    this.railway = new Railway(routeData, REGIONS);
    this.route = this.railway.main;
    this.scenario = applyOverrides(scenario, overrides, this.route);
    const s = this.scenario;
    this.line = this.railway.view(startTrack(s, this.route));
    this.overrides = overrides;
    this.field = new TerrainField(this.route);
    const preset = effective();

    // ---- environment ----
    const clockScale = s.rules ? s.timeScale : settings.get().dayNightSpeed;
    this.baseTimeScale = clockScale;
    this.god = new GodMode(!s.rules);
    this.time = new TimeOfDay(parseClock(s.time), clockScale);
    this.startClock = this.time.seconds;
    this.weather = new Weather(s.weather);
    this.cameras = new CameraManager(innerWidth / innerHeight, preset.drawDistance + 400);
    this.sky = new Sky(2000);
    this.scene.add(this.sky.group, this.world);
    this.world.add(this.weather.rainMesh);
    this.lighting = new Lighting(this.scene, this.world);
    this.lighting.applyQuality(preset);
    this.scene.background = new THREE.Color(0x000000);

    // ---- terrain & world ----
    this.chunks = new ChunkManager(this.route, () => effective());
    this.world.add(this.chunks.root);
    this.world.add(buildRivers(this.route));
    for (const r of this.route.roads) this.world.add(r.kind === 'lc' ? buildLcRoad(this.field, r) : buildParallelRoad(this.route, r));
    this.route.roads.forEach(r => {
      if (r.kind !== 'lc') return;
      const lc = this.route.data.levelCrossings.find(l => Math.abs(l.km - r.km) < 1e-6)!;
      const v = new LevelCrossingView(this.route, this.field, r, lc.manned);
      this.lcs.push(v);
      this.world.add(v.group);
    });
    this.traffic = new Traffic(this.route, this.field, this.lcs);
    this.world.add(this.traffic.group);
    this.waterfalls = new Waterfalls(this.route, this.field);
    this.world.add(this.waterfalls.group);
    for (const sw of this.railway.layout.switches) { const v = new SwitchView(this.route, sw); this.switchViews.push(v); this.world.add(v.group); }
    const f = newFrame();
    const nChunks = Math.ceil(this.route.alignment.length / CHUNK_M);
    for (let i = 0; i < nChunks; i++) { this.route.alignment.sample((i + 0.5) * CHUNK_M, f); this.chunkCentres.push(new THREE.Vector3(f.x, f.y, f.z)); }
    this.setupStreaming();

    // ---- signalling (each running direction has its own) ----
    this.ctl = new RailControl(this.railway);
    this.lc = this.ctl.of(this.line);

    // ---- player train ----
    const loco = locoOrDefault(s.consist.loco);
    this.consist = new Consist(loco, COACHES, s.consist);
    const head = startHeadKm(s, this.line, this.consist.length);
    this.dyn = new TrainDynamics(this.consist, head);
    // start with the train brake applied: driver must charge and release
    const FS = BRAKE_POSITIONS.indexOf('Full Service');
    this.dyn.brakes.handle = FS;
    this.dyn.brakes.er = 3.5;
    this.dyn.brakes.bp.fill(3.5);
    this.dyn.brakes.bc.fill(3.8);
    this.sys = new LocoSystems(loco, this.dyn.brakes);
    const startSt = s.start.atPlatform ? this.line.station(s.start.atPlatform) : undefined;
    const startOffset = startSt?.lineInfo.find(l => l.id === s.start.line)?.offset ?? this.line.running.offset;
    this.path = new TrackPath(this.line.graph, head, this.dyn.tailKm, startOffset);
    this.plan = planFromTimetable(s.timetable);
    const dyn = this.dyn, plan = this.plan;
    this.player = {
      id: 'player', plan,
      get headKm() { return dyn.headKm; }, get tailKm() { return dyn.tailKm; }, get speed() { return dyn.speed; },
      offsetAt: (km: number) => this.path.offsetAt(km),
    };
    this.lc.add(this.player);
    if (startSt) this.dispatcher.startAt(this.player, startSt.code, this.time.seconds);
    this.trainView = new TrainView(this.consist.vehicles, loco, COACHES);
    this.world.add(this.trainView.group);
    const layout = cabLayout(loco.lengthM);
    this.cab = new CabModel(layout);
    this.controls = new CabControls(layout, this.sys, this.dyn.brakes);
    this.cab.group.add(this.controls.group);
    this.trainView.loco.body.add(this.cab.group);

    // ---- AI trains: scenario trains (km in the data are surveyed km), then traffic on the other line ----
    for (const def of s.aiTrains) {
      const view = this.railway.view(def.track ?? this.line.running.id);
      const d = { ...def, startKm: view.viewKm(def.startKm), despawnKm: view.viewKm(def.despawnKm) };
      this.addAI(new AITrain(d, view, this.ctl.of(view).block), view);
    }
    if (this.railway.double) this.startOncoming();

    // ---- gameplay ----
    this.rules = new Rules(this.line, this.block, this.scoring, this.plan, s.endStation, this.consist.length, s.rules, () => this.god.eff);
    this.scoring.enabled = !this.god.usedThisRun;
    this.offs.push(this.god.onChange(() => this.applyGod()));
    this.scene.add(this.highlight.group);
    // the player can change line (teleport), so listen on every direction's dispatcher
    for (const l of this.ctl.lines) l.dispatcher.listeners.push({
      arrived: (t, st, clock) => { if (t.id === 'player' && l === this.lc) this.rules.arrived(st, clock, this.dyn.headKm); },
      departed: (t, st, clock) => { if (t.id === 'player' && l === this.lc) this.rules.departed(st, !!this.dispatcher.stationState('player', st.code)?.arrived, clock); },
    });

    // ---- cameras ----
    for (const m of [this.cabCam, new FrontCamera(), new RearCamera(), new SideCamera(), new ChaseCamera(), new CinematicCamera(), this.freeCam]) this.cameras.register(m);

    // ---- UI ----
    this.hud = new HUD(ui, () => this.togglePause(false));
    this.profile = new TrackProfile(ui);
    this.minimap = new Minimap(ui, this.route, () => this.line.running.id);
    this.perf = new PerfOverlay(ui, rs);
    // vigilance ACKNOWLEDGE pop-up (desktop shows the key too)
    this.vigPopup = new VigilancePopup(ui, () => (isTouch ? null : settings.get().keys.vigilance.replace(/^Key/, '')), () => this.sys.acknowledgeVigilance(this.dyn.speed));
    if (isTouch) {
      // the full gauges, track profile and map are pop-ups from the More drawer: tap one to close it
      this.hud.root.querySelector('.hud-panel')!.addEventListener('click', () => { if (this.hud.root.classList.contains('details')) this.hud.toggleDetails(); });
      this.minimap.canvas.addEventListener('click', () => this.minimap.canvas.classList.remove('shown'));
      this.touch = new TouchControls(ui, {
        sys: this.sys, notches: loco.notches,
        brake: () => ({ handle: this.dyn.brakes.handle, independent: this.dyn.brakes.independent }),
        act: (a, down) => this.onAction(a, down, new KeyboardEvent(down ? 'keydown' : 'keyup')),
        setReverser: r => this.sys.setReverser(r),
        camera: i => this.cameras.select(i, this.cameraContext(0.016)),
        cameraIndex: () => this.cameras.index,
        toggleDetails: () => this.hud.toggleDetails(),
        toggleMap: () => this.minimap.canvas.classList.toggle('shown'),
        autoHide: () => settings.get().touchAutoHide,
        pause: () => this.togglePause(false),
        leverLayout: () => settings.get().leverLayout,
      });
    }

    // ---- input ----
    this.keyboard = new Keyboard({ action: (a, d, e) => this.onAction(a, d, e), digit: n => this.cameras.select(n - 1, this.cameraContext(0)) });
    this.mouse = new Mouse(rs.renderer.domElement, {
      drag: (dx, dy) => { const k = settings.get().mouseSensitivity; this.cameras.drag(dx * k, dy * k); },
      press: (x, y, b) => this.onPress(x, y, b),
      release: () => { if (this.pressedControl) this.controls.release(this.pressedControl); this.pressedControl = null; },
      wheel: (dy, x, y) => { const id = this.controlAt(x, y); if (id) this.controls.wheel(id, dy, this.dyn.speed); else this.cameras.wheel(dy); },
      hover: (x, y) => { const id = this.controlAt(x, y); this.hud.setTip(id ? CONTROL_NAMES[id] ?? id : null); },
    });

    // ---- events ----
    this.offs.push(
      bus.on('scenario-end', e => this.onEnd(e.success, e.reason)),
      bus.on('wheel-slip', e => { if (e.on) bus.emit('message', { text: 'Wheel slip! Ease the throttle or use sand (X)', kind: 'warn' }); }),
      settings.subscribe(() => this.applySettings()),
    );
    document.addEventListener('visibilitychange', this.onVisibility);
    this.offs.push(() => document.removeEventListener('visibilitychange', this.onVisibility));
    this.traffic.onHonk = p => this.trainAudio?.honk(p.x, p.y, p.z);
    let pantoHintAt = -Infinity;
    this.offs.push(bus.on('needs-pantograph', () => {
      const now = performance.now();
      if (now - pantoHintAt < 3000) return;
      pantoHintAt = now;
      bus.emit('message', { text: isTouch ? 'Raise pantograph first' : 'Raise pantograph first (P)', kind: 'warn', ms: 2500 });
    }));

    // ---- loop ----
    this.engine = new Engine(dt => this.sim(dt), (dt, a) => this.frame(dt, a));
    this.engine.paused = true;
    this.engine.onError = e => this.fail(e);
    rs.setScene(this.scene, this.rcam);
    this.applySettings();
    this.onResize();
    addEventListener('resize', this.onResize);
    addEventListener('orientationchange', this.onResize);
    document.addEventListener('fullscreenchange', this.onFullscreen);
    document.addEventListener('webkitfullscreenchange', this.onFullscreen);
    addEventListener('pageshow', this.onPageShow);
    this.offs.push(() => {
      removeEventListener('orientationchange', this.onResize);
      document.removeEventListener('fullscreenchange', this.onFullscreen);
      document.removeEventListener('webkitfullscreenchange', this.onFullscreen);
      removeEventListener('pageshow', this.onPageShow);
    });
    if (isTouch) this.resumeScreen = new ResumeScreen(document.body, () => this.resume(), () => Game.quit());
  }

  // ------------------------------------------------------------------ setup
  /** Draw an AI train (goods or passenger) and register it with its direction's signalling. */
  private addAI(t: AITrain, route: Route) {
    const def = t.def, goods = (def.kind ?? 'goods') === 'goods';
    const loco = goods ? locoOrDefault('ep-7') : (LOCOS.wap7 ?? locoOrDefault('ep-7'));
    const carM = def.carLengthM ?? AI_WAGON_LEN + 0.6;
    const pax = ['general', 'sleeper', 'ac3'].filter(id => COACHES[id]);
    const vehicles: Vehicle[] = [{ kind: 'loco', typeId: loco.id, massKg: 0, length: AI_LOCO_LEN, frontOffset: 0, bogieCentres: loco.bogieCentresM, axleSpacing: loco.axleSpacingM, maxBrakeN: 0, davis: { a: 0, b: 0, c: 0 } }];
    for (let i = 0; i < def.wagons; i++) {
      // express make-up: general coaches at both ends, sleepers with an AC coach every few
      const type = goods ? 'goods' : pax[i < 2 || i >= def.wagons - 2 ? 0 : i % 5 === 0 ? Math.min(2, pax.length - 1) : Math.min(1, pax.length - 1)];
      const c = COACHES[type];
      vehicles.push({ kind: 'coach', typeId: type, massKg: 0, length: c.lengthM, frontOffset: AI_LOCO_LEN + 0.6 + i * carM, bogieCentres: c.bogieCentresM, axleSpacing: c.axleSpacingM, maxBrakeN: 0, davis: { a: 0, b: 0, c: 0 } });
    }
    const view = new TrainView(vehicles, loco, COACHES, goods ? 'freight' : 'passenger');
    this.world.add(view.group);
    this.ctl.of(route).add(t);
    this.ai.push({ train: t, view, route, carM });
  }

  private removeAI(t: AITrain) {
    const i = this.ai.findIndex(a => a.train === t);
    if (i < 0) return;
    const { view } = this.ai[i];
    this.ai.splice(i, 1);
    view.group.removeFromParent();
    // loco geometry is per model; coach geometry is shared (cached), only its instance buffers go
    view.loco.group.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
    view.group.traverse(o => { if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose(); });
  }

  /** Scheduled traffic on the line the player is not on (double line only). */
  private startOncoming() {
    const other = this.ctl.lines.find(l => l !== this.lc);
    if (!other) return;
    let seed = 7;
    for (const ch of this.scenarioId + other.route.running.id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const tm = new TrafficManager(other, { ...DEFAULT_TRAFFIC, seed });
    tm.onSpawn = t => this.addAI(t, other.route);
    tm.onDespawn = t => this.removeAI(t);
    this.oncoming = tm;
  }

  /**
   * Move the player to another running line (a direction view): its routes are
   * released, rules restart for the new line, and the other line's traffic is
   * rebuilt. The caller places the train.
   */
  private switchLine(v: Route) {
    if (v === this.line) return;
    this.dispatcher.departNow.delete('player');
    this.lc.remove(this.player);
    if (this.oncoming) { this.oncoming.reset(); this.oncoming = null; }
    this.line = v;
    this.lc = this.ctl.of(v);
    this.lc.add(this.player);
    this.rules = new Rules(v, this.block, this.scoring, this.plan, this.scenario.endStation, this.consist.length, this.scenario.rules, () => this.god.eff);
    if (this.railway.double) this.startOncoming();
    this.applyGod();
  }

  private setupStreaming() {
    const f = newFrame();
    const add = (km0: number, km1: number, build: () => THREE.Object3D, dispose?: (o: THREE.Object3D) => void, materials: string[] = []) => {
      this.route.alignment.sample(((km0 + km1) / 2) * 1000, f);
      const item: Streamed = { center: new THREE.Vector3(f.x, f.y, f.z), radius: (km1 - km0) * 500 + 50, build, obj: null, materials, texHeld: false };
      item.dispose = () => { if (item.obj) { dispose ? dispose(item.obj) : disposeObject(item.obj); item.obj = null; } };
      this.streamed.push(item);
    };
    for (const b of this.route.bridges) add(b.fromKm, b.toKm, () => buildBridge(this.route, this.field, b));
    for (const t of this.route.tunnels) add(t.fromKm, t.toKm, () => buildTunnel(this.route, t), undefined, ['tunnel']);
    for (const st of this.route.stations) {
      add(st.platformFromKm, st.platformToKm, () => { const v = new StationView(this.route, st); this.stations.set(st.code, v); return v.group; },
        () => { this.stations.get(st.code)?.dispose(); this.stations.delete(st.code); }, StationView.MATERIALS);
    }
  }

  async load(progress: (text: string, p: number) => void) {
    const cam = this.cameras.camera;
    // initial camera pose: driver's cab
    this.trainView.update(this.route, this.dyn.headKm, this.pathOffset, 0, 0);
    this.cameras.update(this.cameraContext(0.016));
    progress('Starting terrain workers', 0.05);
    const t0 = performance.now();
    while (!this.chunks.workersReady) {
      await sleep(50);
      if (performance.now() - t0 > 20000) throw new Error('Terrain workers did not start');
    }
    this.updateStreaming(true);
    const total = Math.max(1, this.chunks.pendingNear(cam.position.x, cam.position.z, 1500));
    while (performance.now() - t0 < 30000) {
      this.chunks.update(cam.position.x, cam.position.z);
      const left = this.chunks.pendingNear(cam.position.x, cam.position.z, 1500);
      progress(`Generating terrain and scenery (${total - left}/${total} tiles)`, 0.1 + 0.8 * (1 - left / total));
      if (left === 0) break;
      await sleep(60);
    }
    this.syncRenderCamera();
    progress('Loading textures', 0.9);
    await textures.settle();
    progress('Compiling shaders', 0.95);
    try { await this.rs.renderer.compileAsync(this.scene, this.rcam); } catch { /* optional warm-up */ }
    progress('Ready', 1);
  }

  /**
   * Background tab: stop rendering and simulating (and audio) entirely; on
   * return the loop restarts with a fresh clock, so nothing jumps.
   */
  private onVisibility = () => {
    if (this.ended || !this.started) return;
    if (document.hidden) {
      // phones: freeze the run now; coming back needs a tap (fullscreen and audio only start inside one)
      if (isTouch) this.suspend();
      this.rs.renderer.setAnimationLoop(null);
      this.audio?.ctx.suspend().catch(() => {});
    } else {
      this.engine.resetClock();
      this.rs.renderer.setAnimationLoop(t => this.engine.tick(t));
      this.pausedNeedsRender = true;
      if (!this.engine.paused) this.audio?.ctx.resume().catch(() => {});
    }
  };

  /** Back-forward cache restore: same as coming back to the tab. */
  private onPageShow = (e: PageTransitionEvent) => { if (e.persisted) { this.onVisibility(); if (isTouch) this.suspend(); } };

  /** Leaving fullscreen during play (back / swipe gesture) freezes the run behind "Tap to continue". */
  private onFullscreen = () => {
    const fs = isFullscreen();
    if (this.wasFullscreen && !fs && isTouch) this.suspend();
    this.wasFullscreen = fs;
    this.onResize();
  };

  /**
   * Freeze the run without the pause menu (touch: the tab was hidden or
   * fullscreen was left) and show "Tap to continue". Nothing moves until the tap.
   */
  private suspend() {
    if (this.ended || !this.started || !this.resumeScreen) return;
    if (!this.engine.paused) {
      this.engine.paused = true;
      this.keyboard.enabled = false;
      this.mouse.enabled = false;
      this.rs.renderer.domElement.classList.add('paused');
      if (this.tutorialCard) this.tutorialCard.el.hidden = true;
      this.audio?.fadeOut();
      this.resumeScreen.show();
    }
  }

  async begin(opts: { tutorial?: boolean } = {}) {
    enterGameScreen(); // phones: fullscreen + landscape lock, inside the Start tap
    if (this.audio) {
      this.audio.resume();
      this.shots = new OneShots(this.audio);
      this.trainAudio = new TrainAudio(this.audio, this.shots, this.consist.loco, this.consist.coachCount);
      this.ambience = new Ambience(this.audio, this.shots);
      await this.trainAudio.init();
      this.applySettings();
    }
    this.menus.inGame = true;
    this.menus.hide();
    this.wasFullscreen = isFullscreen();
    if (isTouch) iosFullscreenTip(document.body);
    if (this.bench) this.prepareForBench();
    this.engine.paused = false;
    this.started = true;
    this.rs.renderer.setAnimationLoop(t => this.engine.tick(t));
    const s = this.scenario;
    bus.emit('message', { text: `${s.name} - ${WEATHER[s.weather].name}, ${formatClock(this.time.seconds)}`, kind: 'info', ms: 6000 });
    bus.emit('message', { text: isTouch ? 'Prepare the loco: raise the pantograph (bottom bar), close the main breaker (\u22ef), reverser F, then the BRAKE lever up and THROTTLE up.' : 'Prepare the loco: P pantograph, O main breaker, ; release brakes, W reverser forward. F1 for help.', kind: 'info', ms: 12000 });
    if (s.timetable[0]?.dep) bus.emit('message', { text: `Departure ${s.timetable[0].dep} from ${this.route.station(s.timetable[0].station)?.name}. Wait for the starter signal.`, kind: 'info', ms: 12000 });
    this.applyGod();
    if (!this.bench && (opts.tutorial || tutorialPrefs.shouldAutoStart())) await this.startTutorial();
  }

  // ------------------------------------------------------------------ God Mode
  /** Apply settings that are not read every sim step (HUD badge/visibility, scoring, weather). */
  private applyGod() {
    const g = this.god, e = g.eff;
    this.hud.setGodMode(g.active);
    this.touch?.setGodMode(g.active);
    this.hud.setHidden(e.hideHud);
    this.touch?.setBare(e.hideHud);
    this.profile.canvas.style.display = e.hideHud || !this.hud.visible ? 'none' : '';
    this.minimap.canvas.style.display = e.hideHud ? 'none' : '';
    this.scoring.enabled = !g.usedThisRun && !this.tutorialPractice;
    if (g.active && e.weather && e.weather !== this.weather.id) this.weather.set(e.weather, true);
    if (e.autoDrive) this.dispatcher.departNow.add('player');
    else if (!this.tutorialPractice) this.dispatcher.departNow.delete('player');
  }

  openGodMode() {
    const back = () => this.showPauseMenu();
    this.menus.panel(godModePanel(this.god, {
      stations: this.route.stations, routeLengthKm: this.route.lengthKm, freeRoam: !this.scenario.rules,
      lines: this.route.runningLines.map(l => l.id), currentLine: this.line.running.id,
      getHours: () => this.time.hours,
      setHours: h => { this.time.seconds = h * 3600; this.pausedNeedsRender = true; },
      setWeather: id => { this.weather.set(id, true); this.pausedNeedsRender = true; },
      currentWeather: () => this.weather.id,
      teleport: target => { void this.teleportTo(target); },
      back, resume: () => this.resume(),
      textureTest: () => this.openTextureTest(),
      bugCameras: BUG_CAMERAS[this.route.data.id] ?? [],
      bugCamera: id => { void this.bugCamera(id); },
    }), back);
  }

  /**
   * God Mode -> Bug check cameras: bring the train near the place (stopped,
   * brakes on), set time and weather if the preset asks, and put the free
   * camera at the preset view - or the cab view for views inside tunnels.
   */
  private async bugCamera(id: string) {
    const c = (BUG_CAMERAS[this.route.data.id] ?? []).find(x => x.id === id);
    if (!c) return;
    if (c.hours !== undefined) this.time.seconds = c.hours * 3600;
    if (c.weather && c.weather !== this.weather.id) { this.god.set('weather', c.weather); this.weather.set(c.weather, true); }
    await this.teleportTo({ km: c.trainKm ?? Math.max(0.6, (c.eye?.km ?? 1) - 0.15), line: this.railway.main.running.id });
    const ctx = this.cameraContext(0.016);
    if (c.cab || !c.eye || !c.look) { this.cameras.select(0, ctx); return; }
    const a = this.railway.main.alignment, f = newFrame();
    const at = (p: TrackPoint) => { a.sampleOffset(p.km * 1000, p.offset, f); return new THREE.Vector3(f.x, f.y + p.h, f.z); };
    this.cameras.select(6, ctx);
    this.freeCam.place(at(c.eye), at(c.look));
  }

  private texTest: TextureTest | null = null;
  /** camera in a tunnel or under a platform roof (no rain on it) */
  private sheltered = false;
  private vigPopup!: VigilancePopup;
  /** God Mode -> Texture Test: its own scene and loop while the run stays paused; Back returns to God Mode. */
  private openTextureTest() {
    this.menus.hide();
    const canvas = this.rs.renderer.domElement;
    canvas.classList.remove('paused');
    this.hud.setHidden(true);
    this.touch?.setBare(true);
    this.profile.canvas.style.display = this.minimap.canvas.style.display = 'none';
    this.texTest = new TextureTest(this.rs, () => {
      this.texTest = null;
      canvas.classList.add('paused');
      this.applyGod();
      this.rs.setScene(this.scene, this.rcam);
      this.rs.renderer.setAnimationLoop(t => this.engine.tick(t));
      this.pausedNeedsRender = true;
      this.openGodMode();
    });
  }

  /**
   * Move the player's train to a station stop marker or a km, stopped with the
   * brakes on. Track, terrain and scenery are streamed in first (loading
   * spinner) so the train never appears in empty space.
   */
  async teleportTo(target: { station?: string; km?: number; line?: string }) {
    if (this.teleporting) return;
    this.teleporting = true;
    const wasPaused = this.engine.paused;
    this.engine.paused = true;
    // km in data and menus are surveyed km; positions on the line are in its own view
    const here = this.line.canonicalKm(this.dyn.headKm);
    if (target.line && target.line !== this.line.running.id) this.switchLine(this.railway.view(target.line));
    const L = this.line;
    const st = target.station ? L.station(target.station) : undefined;
    const km = st ? L.stopKm(st, this.consist.length) : Math.min(L.lengthKm - 0.05, Math.max(this.consist.length / 1000 + 0.05, L.viewKm(target.km ?? here)));
    const where = `${st ? st.name : `km ${L.canonicalKm(km).toFixed(2)}`}${this.railway.double ? ` (${L.running.id} line)` : ''}`;
    this.menus.loading(`Teleporting to ${where}`, 0.05);
    const d = this.dyn, b = d.brakes;
    d.headKm = km; d.speed = 0; d.accel = 0;
    b.handle = BRAKE_POSITIONS.indexOf('Full Service'); b.er = 3.5; b.bp.fill(3.5); b.bc.fill(3.8);
    this.sys.setThrottle(0); this.sys.regen = 0;
    this.interlocking.releaseTrain('player');
    this.dispatcher.resetTrain('player');
    if (st) this.dispatcher.startAt(this.player, st.code, this.time.seconds);
    this.path = new TrackPath(L.graph, km, d.tailKm, L.running.offset);
    this.oncoming?.reset();
    this.rules.callingOnUntil = -1;
    this.announced.clear();
    this.trainView.update(L, km, x => this.path.offsetAt(x), d.odometer, this.lighting.nightLight);
    this.cameras.update(this.cameraContext(0.016));
    this.syncRenderCamera();
    this.updateStreaming(true);
    const cam = this.cameras.camera.position;
    const t0 = performance.now();
    const total = Math.max(1, this.chunks.pendingNear(cam.x, cam.z, 1200));
    while (performance.now() - t0 < 20000) {
      this.chunks.update(cam.x, cam.z);
      const left = this.chunks.pendingNear(cam.x, cam.z, 1200);
      this.menus.loading(`Loading track and scenery (${total - left}/${total})`, 0.1 + 0.9 * (1 - left / total));
      if (left === 0) break;
      await new Promise(r => setTimeout(r, 60));
    }
    this.teleporting = false;
    this.pausedNeedsRender = true;
    // the loading overlay goes in both cases (teleports also come from God Mode tools while running)
    if (wasPaused) this.resume(); else { this.menus.hide(); this.engine.paused = false; }
    bus.emit('message', { text: `Teleported to ${where}. Brakes applied.`, kind: 'info' });
  }

  // ------------------------------------------------------------------ tutorial
  /** Start (or restart) the "how to start the train" tutorial in the cab at a station. */
  async startTutorial() {
    const data = TUTORIALS['start-train'];
    if (!data) return;
    this.stopTutorial(false);
    const head = this.dyn.headKm;
    const atStation = this.line.stations.find(s => head >= s.platformFromKm && head <= s.platformToKm + 0.05);
    if (!atStation || Math.abs(this.dyn.speed) > 0.1) {
      const nearest = [...this.line.stations].sort((a, b) => Math.abs(a.km - head) - Math.abs(b.km - head))[0];
      await this.teleportTo({ station: nearest.code });
    }
    if (this.engine.paused) this.resume();
    // cold loco: pantograph down, breaker open, lights off, reverser neutral, brakes on
    const s = this.sys, b = this.dyn.brakes;
    s.setThrottle(0); s.regen = 0;
    if (s.pantoUp) s.togglePanto();
    s.headlight = 0;
    s.setReverser(0);
    s.setTrainBrake(BRAKE_POSITIONS.indexOf('Full Service'));
    b.independent = 1;
    this.cameras.select(0, this.cameraContext(0.016));
    this.cabCam.again();
    this.tutorialPractice = true;
    this.dispatcher.departNow.add('player');
    this.applyGod();
    bus.emit('message', { text: 'Tutorial: practice mode, scoring is off until you finish.', kind: 'info', ms: 6000 });
    const t = new Tutorial(data, 'en', isTouch);
    this.tutorial = t;
    this.tutorialCard = new TutorialCard(this.ui, t, () => this.tutorialShowMe());
    t.onStep = step => {
      this.tut = { horn: false, moved: false, underLimit: 0 };
      this.setTutorialHighlight(step.highlight);
      this.touch?.highlight(step.touch?.highlight ?? null);
    };
    t.onFinish = completed => {
      this.stopTutorial(completed);
      bus.emit('message', { text: completed ? 'Tutorial complete. Well driven!' : 'Tutorial skipped. Open it again from the pause menu (Esc).', kind: completed ? 'good' : 'info', ms: 6000 });
    };
    t.start();
  }

  private stopTutorial(_completed: boolean) {
    if (!this.tutorial) return;
    this.tutorial = null;
    this.tutorialCard?.dispose();
    this.tutorialCard = null;
    this.setTutorialHighlight(null);
    this.touch?.highlight(null);
    this.tutorialPractice = false;
    if (!this.god.eff.autoDrive) this.dispatcher.departNow.delete('player');
    this.applyGod();
  }

  private setTutorialHighlight(id: string | null) {
    this.hudPulse?.classList.remove('tut-pulse');
    this.hudPulse = null;
    if (!id) { this.highlight.set(null); return; }
    if (id === 'hud:limit') {
      this.hudPulse = document.querySelector('.hud-panel .limit');
      this.hudPulse?.classList.add('tut-pulse');
      this.highlight.set(this.controls.anchor('display'), 0.12);
      return;
    }
    if (id === 'signal') {
      const sig = this.block.nextSignal(this.dyn.headKm, this.path.offsetAt(this.dyn.headKm), true, this.pathOffset);
      const v = sig ? this.signalViews.get(sig.id) : undefined;
      this.highlight.set(v ? v.group : null, 1.6, 6.5);
      return;
    }
    this.highlight.set(this.controls.anchor(id), id.startsWith('gauge:') ? 0.11 : 0.08);
  }

  /** "Show me": point the cab camera at the step's control (or its gauge). */
  private tutorialShowMe() {
    const step = this.tutorial?.step;
    if (!step) return;
    if (this.cameras.index !== 0) this.cameras.select(0, this.cameraContext(0.016));
    const target = step.showMe ?? step.highlight;
    if (!target || target === 'signal' || target === 'hud:limit') { this.cabCam.yaw = 0; this.cabCam.pitch = -0.05; return; }
    const a = this.controls.anchor(target);
    if (!a) return;
    const p = a.getWorldPosition(new THREE.Vector3());
    this.trainView.loco.body.worldToLocal(p);
    const eye = cabLayout(this.consist.loco.lengthM).eye;
    const dx = p.x - eye.x, dy = p.y - eye.y, dz = p.z - eye.z;
    this.cabCam.yaw = Math.atan2(-dz, dx);
    this.cabCam.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    if (step.showMe && step.showMe !== step.highlight) this.highlight.set(a, 0.11);
  }

  private tutorialState(): TutorialState {
    const d = this.dyn, s = this.sys;
    const sig = this.block.nextSignal(d.headKm, this.path.offsetAt(d.headKm), true, this.pathOffset);
    return {
      pantoPos: s.pantoPos, vcb: s.vcb, headlight: s.headlight, reverser: s.reverser, signalAspect: sig?.aspect ?? 'G',
      bp: d.brakes.locoBP, trainBrake: d.brakes.handle, locoBrake: d.brakes.independent, hornSounded: this.tut.horn,
      notch: s.notch, speedKmph: Math.abs(d.speedKmph), underLimitSeconds: this.tut.underLimit,
      stoppedAfterMoving: this.tut.moved && Math.abs(d.speed) < 0.1,
    };
  }

  /** Benchmark: loco ready to run, fixed camera. */
  private prepareForBench() {
    const s = this.sys, b = this.dyn.brakes;
    s.pantoUp = true; s.pantoPos = 1; s.lineVoltage = 25; s.vcb = true; s.reverser = 1; s.headlight = 2;
    b.handle = 1; b.er = 5; b.bp.fill(5); b.bc.fill(0);
    const idx = { cab: 0, chase: 4, free: 6 }[this.bench!.cfg.view];
    this.trainView.update(this.line, this.dyn.headKm, km => this.path.offsetAt(km), 0, 0);
    this.cameras.update(this.cameraContext(0.016));
    if (idx === 6) {
      // fixed free-camera pose: 40 m up, beside the line, looking along it
      const f = newFrame();
      this.line.alignment.sampleOffset((this.dyn.headKm + 0.4) * 1000, -60, f);
      this.cameras.camera.position.set(f.x, f.y + 40, f.z);
      this.cameras.camera.lookAt(f.x + Math.cos(f.heading) * 300, f.y, f.z + Math.sin(f.heading) * 300);
    }
    this.cameras.select(idx, this.cameraContext(0.016));
  }

  private applySettings() {
    const s = settings.get(), p = effective();
    this.rs.setRenderScale(s.renderScale);
    this.rs.setBloom(s.bloom);
    this.lighting.applyQuality(p);
    wind.setGrassFade(p.grassRadius);
    this.rs.setMaxPixelRatio(s.maxPixelRatio);
    this.rs.setRenderScale(s.renderScale);
    this.cameras.camera.far = p.drawDistance + 400;
    this.audio?.setVolumes(s.volumes);
    if (!this.scenario.rules) this.time.scale = this.bench ? 0 : s.dayNightSpeed;
  }

  private pausedNeedsRender = false;
  private onResize = () => {
    this.pausedNeedsRender = true;
    this.rs.resize(innerWidth, innerHeight);
    this.cameras.camera.aspect = innerWidth / innerHeight;
    this.cameras.camera.updateProjectionMatrix();
  };

  // ------------------------------------------------------------------ input
  private onAction(a: Action, down: boolean, e: KeyboardEvent) {
    const s = this.sys;
    if (this.cameras.index === 6 && FREE_CAM_KEYS.has(e.code)) return; // free camera owns WASD/RF
    if (a === 'horn') {
      if (down) s.setHorn(e.shiftKey ? 'high' : 'low', true);
      else { s.setHorn('low', false); s.setHorn('high', false); }
      return;
    }
    if (a === 'sander') { s.setSander(down); return; }
    if (!down) return;
    switch (a) {
      case 'throttleUp': s.throttle(1); break;
      case 'throttleDown': s.throttle(-1); break;
      case 'regenUp': s.regenStep(1); break;
      case 'regenDown': s.regenStep(-1); break;
      case 'trainBrakeApply': s.trainBrake(1); break;
      case 'trainBrakeRelease': s.trainBrake(-1); break;
      case 'locoBrakeApply': s.locoBrake(0.25); break;
      case 'locoBrakeRelease': s.locoBrake(-0.25); break;
      case 'emergency': s.emergency(); break;
      case 'reverserFwd': s.reverserStep(1); break;
      case 'reverserBack': s.reverserStep(-1); break;
      case 'headlights': s.cycleHeadlight(); break;
      case 'wipers': s.cycleWipers(); break;
      case 'vigilance': s.acknowledgeVigilance(this.dyn.speed); break;
      case 'pantograph': s.togglePanto(); break;
      case 'vcb': s.toggleVcb(); break;
      case 'cabLight': s.toggleCabLight(); break;
      case 'markers': s.toggleMarkers(); break;
      case 'flasher': s.toggleFlasher(); break;
      case 'hud': this.hud.toggle(); this.profile.canvas.style.display = this.hud.visible ? '' : 'none'; break;
      case 'map': this.minimap.toggle(); break;
      case 'perf': this.perf.toggle(); break;
      case 'help': this.togglePause(true); break;
      case 'pause': this.togglePause(false); break;
      case 'prevVehicle': this.cameras.cycle(-1, this.consist.vehicles.length); break;
      case 'nextVehicle': this.cameras.cycle(1, this.consist.vehicles.length); break;
    }
  }

  /**
   * Pause: simulation (physics, signals, AI, timers, scoring) stops, audio fades
   * out, mouse look is off, and rendering stops so the last frame stays on screen
   * (blurred/darkened by CSS) without costing GPU time.
   */
  pause() {
    if (this.ended || this.engine.paused) return;
    this.engine.paused = true;
    this.keyboard.enabled = false;
    this.mouse.enabled = false;
    this.rs.renderer.domElement.classList.add('paused');
    if (this.tutorialCard) this.tutorialCard.el.hidden = true;
    this.audio?.fadeOut();
    this.showPauseMenu();
  }

  /** Resume from a tap (pause menu Resume, "Tap to continue"): back to fullscreen, audio on, resized, running. */
  resume() {
    if (this.ended) return;
    enterGameScreen();
    this.resumeScreen?.hide();
    this.onResize();
    this.menus.hide();
    this.rs.renderer.domElement.classList.remove('paused');
    if (this.tutorialCard) this.tutorialCard.el.hidden = false;
    this.engine.paused = false;
    this.keyboard.enabled = true;
    this.mouse.enabled = true;
    this.audio?.fadeIn(settings.get().volumes.master);
  }

  private showPauseMenu() {
    this.menus.pause({
      title: `${this.scenario.name} · ${this.route.data.name}`,
      godActive: this.god.active,
      resume: () => this.resume(),
      tutorial: () => this.startTutorial(),
      godMode: () => this.openGodMode(),
      restart: () => this.restart(),
      quit: () => Game.quit(),
    });
  }

  /** Esc / Menu button: open the pause menu, or go back one level / resume when it is open. */
  private togglePause(help: boolean) {
    if (this.ended) return;
    if (this.texTest) { this.texTest.dispose(); return; }
    if (!this.engine.paused) {
      this.pause();
      if (help) this.menus.help(() => this.showPauseMenu());
    } else if (!this.menus.escape()) this.resume();
  }

  /** Stop everything and show the friendly error screen (details go to the console). */
  fail(e: unknown) {
    this.ended = true;
    this.rs.renderer.setAnimationLoop(null);
    this.keyboard.enabled = false;
    this.audio?.ctx.suspend().catch(() => {});
    this.menus.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  }

  restart() {
    try { sessionStorage.setItem('railbharat.autostart', JSON.stringify({ id: this.scenarioId, overrides: this.overrides })); } catch { /* ignore */ }
    location.reload();
  }
  overrides: ScenarioOverrides = {};
  static quit() { try { sessionStorage.removeItem('railbharat.autostart'); } catch { /* ignore */ } location.reload(); }

  private controlAt(x: number, y: number): string | null {
    if (!this.cameras.mode.inCab) return null;
    this.raycaster.setFromCamera(new THREE.Vector2(x, y), this.rcam);
    const hit = this.raycaster.intersectObjects(this.controls.hitTargets, false)[0];
    return hit && hit.distance < 2.5 ? (hit.object.userData.control as string) : null;
  }

  private onPress(x: number, y: number, button: number) {
    this.audio?.resume();
    const id = this.controlAt(x, y);
    if (!id) return;
    this.pressedControl = id;
    this.controls.press(id, button, this.dyn.speed);
  }

  // ------------------------------------------------------------------ simulation
  private limitAt = (km: number) => {
    let v = Math.min(this.line.speedLimitAt(km), this.god.eff.unlimitedSpeed ? Infinity : this.consist.loco.maxSpeedKmph);
    if (Math.abs(this.pathOffset(km) - this.line.running.offset) > 0.3) v = Math.min(v, 30); // loop lines, turnouts, wrong line
    if (km <= this.rules.callingOnUntil) v = Math.min(v, 15);
    return v;
  };

  /** Limit for the whole train: a restriction applies until the tail has cleared it. */
  private currentLimit() {
    let v = Infinity;
    for (let km = this.dyn.tailKm; km <= this.dyn.headKm + 1e-6; km += 0.025) v = Math.min(v, this.limitAt(km));
    return Math.min(v, this.limitAt(this.dyn.headKm));
  }

  private sim(dt: number) {
    const d = this.dyn, s = this.sys;
    const env = {
      grade: (km: number) => this.line.alignment.gradientAt(km),
      curvature: (km: number) => this.line.alignment.curvatureAt(km),
      minKm: 0.01, maxKm: this.line.lengthKm - 0.02,
    };
    const limit = this.currentLimit();
    const e = this.god.eff;
    d.massScale = e.massMultiplier; d.powerScale = e.powerMultiplier; d.ignoreMaxSpeed = e.unlimitedSpeed; d.noSlip = e.noWheelSlip;
    d.brakes.instant = e.instantBrakes; d.brakes.infiniteAir = e.infiniteAir;
    s.vigilanceEnabled = e.vigilance; s.ignoreMaxSpeed = e.unlimitedSpeed;
    for (const l of this.ctl.lines) l.block.forceGreen = l === this.lc && e.forceGreen;
    this.time.scale = this.god.active ? (e.freezeTime ? 0 : e.timeSpeed) : this.baseTimeScale;
    if (e.autoDrive || e.autoStopAtRed) {
      const targets = { limitKmph: limit, nextStop: this.block.nextSignal(d.headKm, this.path.offsetAt(d.headKm), true, this.pathOffset), stationStopKm: this.nextBookedStopKm() };
      if (e.autoDrive) this.autoDriver.drive(dt, d, s, targets);
      else this.autoDriver.autoStop(d, s, targets);
    }
    s.update(dt, d.speed, limit, true);
    d.baseAdhesion = this.weather.adhesion(this.consist.loco.adhesion) * (1 + Math.sin(this.t * 0.37) * 0.04);
    const prevHead = d.headKm;
    if (this.bench) { d.speed = this.bench.cfg.speedKmph / 3.6; s.vigilanceTimer = 0; }
    d.step(dt, { notch: s.notch, regenNotch: s.regen, reverser: s.reverser, sander: s.sander, powerAvailable: s.powerAvailable }, env);
    if (this.bench) d.speed = this.bench.cfg.speedKmph / 3.6;
    for (const id of this.path.update(d.headKm, d.tailKm)) bus.emit('switch-crossed', { id });
    // scenario AI trains (traffic trains are moved by their manager)
    const traffic = this.oncoming?.trains;
    for (const a of this.ai) if (!a.train.gone && !traffic?.includes(a.train)) a.train.update(dt);
    for (const a of [...this.ai]) if (a.train.gone && !traffic?.includes(a.train)) { this.ctl.of(a.route).remove(a.train); this.removeAI(a.train); }
    if (this.oncoming && !this.bench) this.oncoming.update(dt, this.oncoming.route.viewKm(this.line.canonicalKm(d.headKm)));

    // wheel slip / coupler events
    const slip = d.traction.slipping;
    if (slip !== this.slipping) { this.slipping = slip; bus.emit('wheel-slip', { on: slip }); }
    this.smoothJerk += (d.jerk - this.smoothJerk) * Math.min(1, dt * 2.5);
    this.joltCooldown -= dt;
    const startOff = Math.abs(this.prevSpeed) < 0.03 && Math.abs(d.speed) >= 0.03 && Math.abs(d.traction.tractiveForce) > 0;
    if (this.joltCooldown <= 0 && (startOff || Math.abs(this.smoothJerk) > 0.9)) {
      const mag = startOff ? 0.6 : Math.min(1, Math.abs(this.smoothJerk) / 2);
      bus.emit('coupler-jolt', { magnitude: mag });
      this.jolt = Math.max(this.jolt, mag);
      this.joltCooldown = 2.5;
    }
    this.jolt = Math.max(0, this.jolt - dt * 2);
    this.prevSpeed = d.speed;
    this.bpRate = (d.brakes.locoBP - this.lastBP) / dt;
    this.lastBP = d.brakes.locoBP;

    this.time.update(dt);
    this.t += dt;

    // signalling and station working at 10 Hz
    this.sigAcc += dt;
    if (this.sigAcc >= 0.1) {
      this.ctl.update(this.sigAcc, this.time.seconds);
      // crossing gates close for a train approaching on either line (each checked in its own direction's km)
      for (const lc of this.lcs) {
        const near = this.ctl.lines.some(l => {
          const k = l.route.viewKm(lc.road.km);
          return l.trains.some(o => (o.headKm > k - 1.6 && o.headKm < k + 0.05) || (o.tailKm < k + 0.03 && o.headKm > k));
        });
        lc.update(this.sigAcc, near);
      }
      this.sigAcc = 0;
    }
    this.rules.update({
      prevHead, head: d.headKm, speed: d.speed, offsetAt: km => this.path.offsetAt(km), horn: s.hornLow || s.hornHigh,
      jerk: this.smoothJerk, clock: this.time.seconds, limit, emergency: d.brakes.emergency, hitBuffer: d.hitBuffer, dt,
    });
  }

  // ------------------------------------------------------------------ frame
  private cameraContext(dt: number): CameraContext {
    const v = this.dyn.speed;
    return {
      dt, time: this.t, train: this.trainView, route: this.line, field: this.field, headKm: this.dyn.headKm, speed: v,
      lateralAccel: v * v * this.line.alignment.curvatureAt(this.dyn.headKm), slack: this.dyn.slack, jolt: this.jolt, shake: this.shake,
      eye: cabLayout(this.consist.loco.lengthM).eye, keys: c => this.keyboard.isDown(c),
      freeRange: this.god.eff.unlockFreeCamera ? Infinity : 4000,
    };
  }

  private updatePathLookahead() {
    const head = this.dyn.headKm;
    const { ramps } = this.line.graph.followForward(head, this.path.offsetAt(head), head + 4);
    const known = new Set(this.path.ramps.map(r => r.switchId));
    this.aheadRamps = [...this.path.ramps, ...ramps.filter(r => !known.has(r.switchId))].sort((a, b) => a.start - b.start);
    const base = this.path.baseOffset, list = this.aheadRamps;
    this.pathOffset = km => TrackGraph.offsetFromRamps(base, list, km);
  }

  private frame(dt: number, _alpha: number) {
    if (this.engine.paused) {
      // frozen frame: only redraw when the canvas was resized (resizing clears it)
      if (this.pausedNeedsRender) { this.pausedNeedsRender = false; this.syncRenderCamera(); this.rs.render(); }
      return;
    }
    this.gamepad.poll({
      setThrottleFraction: f => this.sys.setThrottle(f * this.consist.loco.notches),
      setTrainBrakeFraction: f => this.sys.setTrainBrake(1 + f * (BRAKE_POSITIONS.length - 2)),
      button: (n, down) => {
        const map: Record<string, Action> = { horn: 'horn', sander: 'sander', vigilance: 'vigilance', headlights: 'headlights', locoBrakeApply: 'locoBrakeApply', locoBrakeRelease: 'locoBrakeRelease', reverserFwd: 'reverserFwd', reverserBack: 'reverserBack' };
        if (n === 'camera') { if (down) this.cameras.select((this.cameras.index + 1) % 7, this.cameraContext(dt)); return; }
        this.onAction(map[n], down, new KeyboardEvent('keydown'));
      },
      look: (dx, dy) => this.cameras.drag(dx, dy),
    });
    this.updatePathLookahead();
    const d = this.dyn, s = this.sys;
    const night = this.lighting.nightLight;

    // trains
    this.trainView.update(this.line, d.headKm, km => this.path.offsetAt(km), d.odometer, night);
    const lm = this.trainView.loco;
    lm.setPantograph(s.pantoPos);
    lm.setLights(s.headlight, s.markers, s.flasher, this.t, s.reverser);
    for (const a of this.ai) {
      if (a.train.gone) continue;
      a.view.update(a.route, a.train.headKm, km => a.train.offsetAt(km), a.train.headKm * 1000, night);
      a.view.loco.setPantograph(1);
      a.view.loco.setLights(night > 0.3 || this.weather.p.fog > 0.004 ? 2 : 1, true, false, this.t, 1);
    }
    this.updatePassing(dt);

    // camera
    const ctx = this.cameraContext(dt);
    this.cameras.update(ctx);
    this.syncRenderCamera();
    const cam = this.cameras.camera;
    const inCab = !!this.cameras.mode.inCab;
    this.cab.group.visible = inCab;
    if (inCab !== this.lastInCab) {
      // from the driver's seat the undercarriage, pantographs and outer glass are never visible: skip their draws
      this.lastInCab = inCab;
      lm.body.traverse(o => { if (o.name === 'glass') o.visible = !inCab; });
      for (const b of lm.bogies) b.visible = !inCab;
      for (const pt of lm.pantos) pt.base.visible = !inCab;
    }
    this.audio?.setCab(inCab);

    // texture uploads (at most 2 per frame / ~2 ms) and wet-surface roughness
    textures.update();
    textures.setWetness(this.weather.p.rain);
    this.chunks.terrainMaterial.roughness = 0.97 * (1 - 0.35 * Math.min(1, this.weather.p.rain));
    const tm = textures.stats();
    prof.counters.texMB = tm.mb; prof.counters.texCount = tm.count; prof.counters.texQueued = tm.queued + tm.loading; prof.counters.texBudget = tm.budgetMB;
    // world streaming
    prof.begin('stream');
    this.streamAcc += dt;
    if (this.streamAcc > 0.25) { this.streamAcc = 0; this.updateStreaming(false); }
    prof.end('stream');

    // environment
    const tunnelKm = this.cameraInTunnel();
    this.lighting.tunnel += ((tunnelKm ? 1 : 0) - this.lighting.tunnel) * Math.min(1, dt * 1.5);
    const speedVec = new THREE.Vector3(Math.cos(this.headHeading()) * d.speed, 0, Math.sin(this.headHeading()) * d.speed);
    // shelter: no rain inside tunnels; none under platform roofs near the camera (cab glass and roof drumming too)
    const roofs: RoofCover[] = [];
    for (const sv of this.stations.values()) for (const r of sv.roofs) if (Math.hypot(r.x - cam.position.x, r.z - cam.position.z) < r.halfLen + 60) roofs.push(r);
    const covered = roofs.length ? (x: number, y: number, z: number) => underRoof(roofs, x, y, z) : undefined;
    this.sheltered = !!tunnelKm || !!covered?.(cam.position.x, cam.position.y, cam.position.z);
    this.weather.update(dt, cam.position, inCab ? speedVec : new THREE.Vector3(), inCab ? 3.2 : 0, !!tunnelKm, covered);
    wind.update(dt, this.weather.p.wind);
    this.sky.group.scale.setScalar((cam.far * 0.85) / 2000);
    this.sky.update(dt, this.rcam.position, this.time, this.weather);
    const lampSpots: THREE.Vector3[] = [];
    for (const st of this.stations.values()) lampSpots.push(...st.lampSpots);
    this.lighting.update(inCab ? cam.position : this.trainView.group.position, this.time, this.weather, this.sky, settings.get().fogMultiplier, lampSpots, cam.position);
    this.lighting.fog.density = Math.max(this.lighting.fog.density, 1.35 / effective().drawDistance);
    this.rs.setBloom(settings.get().bloom, 0.25 + night * 0.35 + Math.min(0.4, this.weather.p.fog * 20));
    this.rs.renderer.toneMappingExposure = 1.0 + night * 0.35;
    const headlightOn = s.headlight > 0;
    lm.setBeam(headlightOn ? Math.min(0.12, (night * 0.06 + this.weather.p.fog * 3)) * (s.headlight === 2 ? 1 : 0.5) : 0);

    // cab
    if (inCab) {
      this.cab.update(dt, this.sheltered ? 0 : this.weather.p.rain, d.speed, s.wipers);
      this.cab.lightMat.color.setScalar(s.cabLight ? 3 : 0.2);
      this.cab.cabLight.intensity = s.cabLight ? 2.5 : 0;
      const ns = this.nextSignal();
      const units = settings.get().units;
      const conv = units === 'mph' ? 0.6214 : 1;
      this.controls.update(dt, {
        speedKmph: Math.abs(d.speedKmph), limit: Math.round(this.currentLimit() * conv), bp: d.brakes.locoBP, bc: d.brakes.locoBC, mr: d.brakes.mr, er: d.brakes.er,
        kV: s.lineVoltage, amps: d.traction.motorCurrent, teKN: Math.abs(d.traction.tractiveForce) / 1000,
        slip: d.traction.slipping, overspeed: s.overspeed, vigilance: s.vigilanceState, brakeApplied: d.brakes.locoBC > 0.3,
        pantoDown: s.pantoDown, vcbOpen: !s.vcb, km: this.line.canonicalKm(d.headKm), nextSignal: ns ? ns.id : '-', signalDist: ns ? (ns.km - d.headKm) * 1000 : 99999,
        aspect: ns ? ns.aspect : '-', clock: formatClock(this.time.seconds, true), units: units === 'mph' ? 'mph' : 'km/h', displaySpeed: Math.abs(d.speedKmph) * conv,
      }, night);
    }

    // signals, switches, stations, crossings, traffic
    prof.begin('scenery');
    const blink = Math.sin(this.t * 6) > 0;
    const drawD = effective().drawDistance;
    const fr = newFrame();
    for (const l of this.ctl.lines) for (const sig of l.block.signals) {
      let v = this.signalViews.get(sig.id);
      if (!v) {
        l.route.alignment.sample(sig.km * 1000, fr);
        if (Math.hypot(fr.x - cam.position.x, fr.z - cam.position.z) > Math.min(drawD, 3000)) continue;
        v = new SignalView(l.route, sig);
        this.signalViews.set(sig.id, v);
        this.world.add(v.group);
      }
      const dist = v.position.distanceTo(cam.position);
      v.group.visible = dist < drawD;
      if (v.group.visible) v.update(cam.position, night, this.lighting.fog.density, blink);
    }
    for (const sv of this.switchViews) sv.update();
    for (const st of this.stations.values()) st.update(this.time.seconds, this.t, st.centre.distanceTo(cam.position) < 600);
    this.traffic.update(dt, cam.position);
    this.waterfalls.update(dt, this.weather.p.rain > 0.3 || this.route.regionAt(this.cameraKm()).sideSlope > 0);

    prof.end('scenery');
    // station announcements as the train approaches
    for (const st of this.line.stations) {
      const dist = st.platformFromKm - d.headKm;
      if (dist > 0 && dist < 1.2 && !this.announced.has(st.code)) {
        this.announced.add(st.code);
        const sv = this.stations.get(st.code);
        if (sv) this.trainAudio?.announce(sv.centre.x, sv.centre.y, sv.centre.z);
      }
    }

    // audio
    this.updateAudio(dt);

    // UI
    if (this.tutorial) {
      if (s.hornLow || s.hornHigh) this.tut.horn = true;
      if (Math.abs(d.speedKmph) > 2) this.tut.moved = true;
      const kmph = Math.abs(d.speedKmph);
      this.tut.underLimit = kmph > this.currentLimit() + 2 ? 0 : kmph > 3 ? this.tut.underLimit + dt : this.tut.underLimit;
      this.tutorial.update(dt, this.tutorialState());
      this.tutorialCard?.update();
      if (this.tutorial?.step.highlight === 'signal' && !this.highlight.group.visible) this.setTutorialHighlight('signal');
    }
    this.highlight.update(this.t);
    this.uiAcc += dt; this.profAcc += dt; this.mapAcc += dt;
    if (this.uiAcc > 0.1) { this.uiAcc = 0; this.updateHud(); }
    if (this.profAcc > 0.2 && this.hud.visible) { this.profAcc = 0; this.profile.draw(this.line, this.block, d.headKm, this.limitAt, this.pathOffset, this.oncomingKms()); }
    if (this.mapAcc > 0.5) {
      this.mapAcc = 0;
      this.minimap.draw([
        { km: this.line.canonicalKm(d.headKm), player: true, line: this.line.running.id },
        ...this.ai.filter(a => !a.train.gone).map(a => ({ km: a.route.canonicalKm(a.train.headKm), player: false, line: a.route.running.id })),
      ], cam.position);
    }

    if (this.debugHide.size) this.applyDebugHide();
    prof.begin('render');
    this.rs.render();
    prof.end('render');
    const c = prof.counters;
    c.km = this.line.canonicalKm(d.headKm); c.tiles = this.chunks.tileCount; c.trackChunks = this.trackChunks.size; c.grass = this.chunks.grassCount; c.props = this.chunks.propCount;
    prof.frame(this.engine.rawMs);
    this.bench?.frame(this.engine.rawMs);
    this.perf.frame(dt);
  }

  /**
   * Re-centre the render origin when the camera gets more than 1 km from it.
   * The origin snaps to 500 m so shader phases (wind) are unchanged by a shift.
   * Nothing is rebuilt: only the world group's position and the render camera move.
   */
  private syncRenderCamera() {
    const c = this.cameras.camera;
    if (Math.abs(c.position.x - this.origin.x) > 1000 || Math.abs(c.position.z - this.origin.z) > 1000 || this.origin.lengthSq() === 0) {
      this.origin.set(Math.round(c.position.x / 500) * 500, 0, Math.round(c.position.z / 500) * 500);
      this.world.position.set(-this.origin.x, -this.origin.y, -this.origin.z);
      prof.counters.originX = this.origin.x; prof.counters.originZ = this.origin.z;
    }
    const r = this.rcam;
    r.fov = c.fov; r.aspect = c.aspect; r.near = c.near; r.far = c.far;
    r.position.copy(c.position).sub(this.origin);
    r.quaternion.copy(c.quaternion);
    r.updateProjectionMatrix();
    r.updateMatrixWorld();
  }

  private applyDebugHide() {
    const h = this.debugHide;
    if (h.has('terrain')) this.chunks.root.visible = false;
    if (h.has('props')) for (const tile of this.chunks.root.children) tile.children.forEach((c, i) => { if (i > 0) c.visible = false; });
    if (h.has('grass')) for (const tile of this.chunks.root.children) for (const c of tile.children) if ((c as THREE.Mesh).material === propMaterials().grass) c.visible = false;
    if (h.has('tiles')) for (const tile of this.chunks.root.children) tile.children[0].visible = false;
    if (h.has('track')) for (const g of this.trackChunks.values()) g.visible = false;
    if (h.has('train')) this.trainView.group.visible = false;
    if (h.has('cab')) this.cab.group.visible = false;
    if (h.has('signals')) for (const v of this.signalViews.values()) v.group.visible = false;
    if (h.has('sky')) this.sky.group.visible = false;
    if (h.has('scenery')) for (const it of this.streamed) if (it.obj) it.obj.visible = false;
  }

  /** Head km of the next booked stop marker ahead that has not been served yet (null if none). */
  private nextBookedStopKm() {
    if (!this.god.eff.mustStop) return null;
    for (const st of this.line.stations) {
      if (st.platformToKm < this.dyn.headKm) continue;
      const p = this.plan.get(st.code);
      if (!p?.stop || this.dispatcher.stationState('player', st.code)?.arrived) continue;
      return this.line.stopKm(st, this.consist.length);
    }
    return null;
  }

  private cameraInTunnel() {
    const p = this.cameras.camera.position;
    const n = this.field.nearest(p.x, p.z, 12);
    return !!n && this.route.inTunnel(n.km) && p.y < this.route.alignment.elevationAt(n.km) + 9;
  }

  private headHeading() { return this.line.alignment.sample(this.dyn.headKm * 1000, newFrame()).heading; }

  /** Head km (in the player's view) of trains on the other line. */
  private oncomingKms() {
    return this.ai.filter(a => a.route !== this.line && !a.train.gone).map(a => this.line.viewKm(a.route.canonicalKm(a.train.headKm)));
  }

  /**
   * Trains passing on the other line: when an AI loco's nose passes the cab,
   * play the pressure-wave whoosh and wheel roar, buffet the cab, and now and
   * then the other driver sounds the horn. Strength scales with closing speed.
   */
  private updatePassing(dt: number) {
    this.shake = Math.max(0, this.shake - dt * 1.2);
    const me = this.line;
    const cab = me.canonicalKm(this.dyn.headKm);
    const myV = this.dyn.speed * (me.mirrored ? -1 : 1); // m/s toward increasing surveyed km
    for (const a of this.ai) {
      if (a.route === me || a.train.gone) continue;
      const head = a.route.canonicalKm(a.train.headKm), tail = a.route.canonicalKm(a.train.tailKm);
      const aiV = a.train.speed * (a.route.mirrored ? -1 : 1);
      const rel = Math.abs(myV - aiV);
      const lo = Math.min(head, tail), hi = Math.max(head, tail);
      // alongside: keep buffeting while the train streams past
      if (cab >= lo && cab <= hi && rel > 5) this.shake = Math.max(this.shake, Math.min(0.6, rel / 60));
      const side = Math.sign(head - cab);
      if (a.side !== undefined && side !== a.side && Math.abs(head - cab) < 0.08 && rel > 3) {
        this.shake = Math.max(this.shake, Math.min(1, 0.25 + rel / 40));
        const p = new THREE.Vector3().setFromMatrixPosition(this.trainView.vehicleMatrices[0]);
        this.trainAudio?.passBy(p.x, p.y + 2, p.z, rel, a.train.length, a.carM);
        if (Math.random() < 0.35) {
          const q = new THREE.Vector3().setFromMatrixPosition(a.view.vehicleMatrices[0]);
          this.trainAudio?.honk(q.x, q.y + 4, q.z);
        }
      }
      a.side = side;
    }
  }

  private cameraKm() {
    const p = this.cameras.camera.position;
    const n = this.field.nearest(p.x, p.z, 250);
    return n ? n.km : this.field.kmAt(p.x, p.z);
  }

  private nextSignal() {
    return this.block.nextSignal(this.dyn.headKm, this.path.offsetAt(this.dyn.headKm), false, this.pathOffset);
  }

  private updateStreaming(all: boolean) {
    const cam = this.cameras.camera.position;
    const p = effective();
    this.chunks.update(cam.x, cam.z);
    // track + lineside chunks
    const want = Math.min(p.drawDistance, 2600);
    let built = 0;
    this.chunkCentres.forEach((c, i) => {
      const dd = Math.hypot(c.x - cam.x, c.z - cam.z);
      const have = this.trackChunks.get(i);
      if (dd < want && !have) {
        if (!all && built >= 3) return;
        built++;
        const g = new THREE.Group();
        const tc = buildTrackChunk(this.railway, i);
        const s0 = i * CHUNK_M, s1 = Math.min(this.route.alignment.length, s0 + CHUNK_M);
        const ls = buildLinesideChunk(this.railway, this.field, s0, s1, tc.position.x, tc.position.z);
        ls.position.copy(tc.position);
        g.add(tc, ls);
        this.trackChunks.set(i, g);
        this.world.add(g);
      } else if (dd > want + 400 && have) {
        disposeObject(have);
        this.trackChunks.delete(i);
      }
    });
    for (const it of this.streamed) {
      const dd = Math.hypot(it.center.x - cam.x, it.center.z - cam.z) - it.radius;
      // textures by area: acquire ahead of the build ring, release well after it
      if (!it.texHeld && dd < p.drawDistance + TEX_PREFETCH_M) { it.texHeld = true; for (const m of it.materials) textures.acquire(m); }
      else if (it.texHeld && dd > p.drawDistance + TEX_RELEASE_M) { it.texHeld = false; for (const m of it.materials) textures.release(m); }
      if (dd < p.drawDistance && !it.obj && (all || built < 4)) { built++; it.obj = it.build(); this.world.add(it.obj); }
      else if (dd > p.drawDistance + 600 && it.obj) it.dispose!();
    }
  }

  private updateAudio(dt: number) {
    if (!this.audio || !this.trainAudio) return;
    const cam = this.cameras.camera;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    this.audio.setListener(cam.position.x, cam.position.y, cam.position.z, fwd.x, fwd.y, fwd.z);
    const d = this.dyn;
    const head = d.headKm;
    const st = this.line.structureAt(head);
    const locoPos = new THREE.Vector3().setFromMatrixPosition(this.trainView.vehicleMatrices[0]);
    // nearest bogies to the listener for joint clacks
    const bogies: { key: number; km: number; x: number; y: number; z: number; axle: number }[] = [];
    const v = this.consist.vehicles;
    const f = newFrame();
    for (let i = 0; i < v.length && bogies.length < 40; i++) {
      const c = head - (v[i].frontOffset + v[i].length / 2) / 1000;
      for (const k of [0, 1]) {
        const km = c + (k ? -1 : 1) * v[i].bogieCentres / 2000;
        this.line.alignment.sampleOffset(km * 1000, this.path.offsetAt(km), f);
        bogies.push({ key: i * 2 + k, km, x: f.x, y: f.y + RAIL_TOP, z: f.z, axle: v[i].axleSpacing });
      }
    }
    bogies.sort((a, b) => Math.hypot(a.x - cam.position.x, a.z - cam.position.z) - Math.hypot(b.x - cam.position.x, b.z - cam.position.z));
    this.trainAudio.update({
      speedKmph: d.speedKmph, amps: d.traction.motorCurrent, vcb: this.sys.vcb, compressor: d.brakes.compressorOn,
      curvature: this.line.alignment.curvatureAt(head), steelBridge: st?.type === 'bridge' && st.style !== 'arch-viaduct', tunnel: st?.type === 'tunnel',
      slipping: d.traction.slipping, bpRate: this.bpRate, bc: d.brakes.locoBC, overspeed: this.sys.overspeed,
      loco: locoPos, bogies: bogies.slice(0, 10), dt,
    });
    const tun = this.route.inTunnel(this.cameraKm());
    const ghat = this.line.ghatFactor(head);
    this.audio.setReverb(tun ? 0.55 : 0.06 + ghat * 0.14);
    // ambience inputs
    let river: { x: number; y: number; z: number; d: number } | null = null;
    for (const r of this.route.rivers) {
      for (let i = 0; i < r.points.length; i += 4) {
        const p = r.points[i];
        const dd = Math.hypot(p.x - cam.position.x, p.z - cam.position.z);
        if (!river || dd < river.d) river = { x: p.x, y: r.water, z: p.z, d: dd };
      }
    }
    let station: { x: number; y: number; z: number; d: number } | null = null;
    for (const sv of this.stations.values()) {
      const dd = sv.centre.distanceTo(cam.position);
      if (!station || dd < station.d) station = { x: sv.centre.x, y: sv.centre.y, z: sv.centre.z, d: dd };
    }
    this.ambience!.update(dt, {
      rain: this.sheltered ? this.weather.p.rain * 0.25 : this.weather.p.rain, wind: this.weather.p.wind, day: this.time.day, speed: d.speed, inCab: !!this.cameras.mode.inCab,
      river, station, cam: cam.position,
      bells: this.lcs.filter(l => l.manned).map((l, i) => ({ id: i, x: l.position.x, y: l.position.y, z: l.position.z, ringing: l.closing && l.position.distanceTo(cam.position) < 900 })),
    });
  }

  private updateHud() {
    const d = this.dyn, s = this.sys;
    const units = settings.get().units;
    const conv = units === 'mph' ? 0.6214 : 1;
    const head = d.headKm;
    const limit = this.currentLimit();
    const ns = this.nextSignal();
    // next station on the line ahead
    const L = this.line;
    const st = L.stations.find(x => x.platformToKm > head + 0.01);
    const stopping = st ? !!this.plan.get(st.code) : false;
    const stDist = st ? ((stopping ? L.stopKm(st, this.consist.length) : st.platformFromKm) - head) * 1000 : 0;
    // next lower limit
    let restriction: { kmph: number; dist: number } | null = null;
    for (let km = head + 0.02; km < head + 4; km += 0.02) {
      const v = this.limitAt(km);
      if (v < limit) { restriction = { kmph: Math.round(v * conv), dist: (km - head) * 1000 }; break; }
    }
    // ETA vs timetable
    let eta = '--', due = '';
    let arrival: { station: string; minutes: number; lateMin: number } | null = null;
    let departure: { station: string; time: string } | null = null;
    const next = this.scenario.timetable.find(e => e.arr && (L.station(e.station)?.platformToKm ?? 0) > head && !this.dispatcher.stationState('player', e.station)?.arrived);
    if (next) {
      const nst = L.station(next.station)!;
      const dist = (L.stopKm(nst, this.consist.length) - head) * 1000;
      const v = Math.max(Math.abs(d.speed), L.speedLimitAt(head) * KMPH * 0.6);
      const etaS = this.time.seconds + dist / v;
      eta = formatClock(etaS);
      const late = Math.round((etaS - parseClock(next.arr!)) / 60);
      due = `Due ${next.arr} at ${nst.name} (${late > 0 ? `+${late}` : late} min)`;
      arrival = { station: nst.name, minutes: (parseClock(next.arr!) - this.time.seconds) / 60, lateMin: late };
    } else {
      const dep = this.scenario.timetable.find(e => e.dep && !this.dispatcher.stationState('player', e.station)?.departed);
      if (dep) {
        due = `Depart ${this.route.station(dep.station)?.name} at ${dep.dep}`;
        departure = { station: this.route.station(dep.station)?.name ?? dep.station, time: dep.dep! };
      }
    }
    this.touch?.update({
      speed: Math.abs(d.speedKmph) * conv, units: units === 'mph' ? 'mph' : 'km/h', limit: Math.round(limit * conv),
      maxKmph: Math.round((this.god.eff.unlimitedSpeed ? Math.max(160, this.consist.loco.maxSpeedKmph) : this.consist.loco.maxSpeedKmph) * conv),
      signal: ns ? { aspect: ns.aspect, dist: (ns.km - head) * 1000 } : null,
      restriction,
      station: st ? { name: st.name, dist: stDist } : null,
      timetable: { clock: formatClock(this.time.seconds, true), arrival, departure, nextStop: st ? st.name : null },
      score: this.scenario.rules && this.scoring.enabled ? this.scoring.total : null,
    });
    this.vigPopup.update(s.vigilanceState, s.vigilanceLeft);
    this.hud.update({
      speed: Math.abs(d.speedKmph) * conv, units: units === 'mph' ? 'mph' : 'km/h', limit: Math.round(limit * conv),
      notch: s.notch > 0 ? `P${s.notch}` : s.regen > 0 ? `B${s.regen}` : '0', reverser: s.reverser > 0 ? 'F' : s.reverser < 0 ? 'R' : 'N',
      bp: d.brakes.locoBP, bc: d.brakes.lastBC, mr: d.brakes.mr,
      signal: ns ? { id: ns.id, aspect: ns.aspect, dist: (ns.km - head) * 1000 } : null,
      station: st ? { name: st.name, dist: stDist, stop: stopping } : null,
      restriction, clock: formatClock(this.time.seconds, true), eta, due,
      gradient: formatGradient(L.alignment.gradientAt(head)), km: L.canonicalKm(head),
      score: this.scenario.rules ? this.scoring.total : null,
      camera: CAMERA_NAMES[this.cameras.index], weather: WEATHER[this.weather.id].name,
    });
  }

  private onEnd(success: boolean, reason: string) {
    if (this.ended) return;
    this.ended = true;
    if (this.scenario.rules && this.scoring.enabled) recordScore(this.scenarioId, this.scoring.total, this.scoring.grade);
    setTimeout(() => {
      this.engine.paused = true;
      this.keyboard.enabled = false;
      this.menus.report({
        success, reason, total: this.scoring.total, grade: this.scoring.grade, totals: this.scoring.totals, entries: this.scoring.entries,
        name: this.scenario.name, distanceKm: this.dyn.odometer / 1000, durationS: this.time.seconds - this.startClock,
      }, { restart: () => this.restart(), quit: () => Game.quit() });
    }, success ? 2500 : 1500);
  }

  /** Debug/test hook: lets automated checks read state. */
  debugState() {
    return { km: this.line.canonicalKm(this.dyn.headKm), line: this.line.running.id, oncoming: this.oncoming?.trains.length ?? 0, speed: this.dyn.speedKmph, bp: this.dyn.brakes.locoBP, signal: this.nextSignal()?.aspect, camera: this.cameras.index, tiles: this.chunks.root.children.length, chunks: this.trackChunks.size };
  }
  debugSystems() { return this.sys; }
  debugTextures() { return textures.stats(); }

  /** Count renderable objects inside the camera frustum, grouped by top-level owner (diagnostics). */
  debugDrawBreakdown() {
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(this.rcam.projectionMatrix, this.rcam.matrixWorldInverse));
    const out: Record<string, number> = {};
    const name = (o: THREE.Object3D) => {
      let p: THREE.Object3D = o;
      while (p.parent && p.parent !== this.world && p.parent !== this.scene) p = p.parent;
      if (p === this.chunks.root || p.parent === this.chunks.root) return 'terrainTiles';
      if (p === this.trainView.group) return 'playerTrain';
      for (const v of this.signalViews.values()) if (v.group === p) return 'signals';
      for (const g of this.trackChunks.values()) if (g === p) return 'trackChunks';
      for (const st of this.stations.values()) if (st.group === p) return 'stations';
      if (p === this.traffic.group) return 'traffic';
      if (this.switchViews.some(s => s.group === p)) return 'switches';
      if (this.streamed.some(s => s.obj === p)) return 'bridgesTunnels';
      if (this.lcs.some(l => l.group === p)) return 'levelCrossings';
      return p.type + ':' + (p.name || 'misc');
    };
    this.scene.updateMatrixWorld();
    this.scene.traverseVisible(o => {
      const m = o as THREE.Mesh;
      if (!(m.isMesh || (o as THREE.Line).isLine || (o as THREE.Points).isPoints || (o as THREE.Sprite).isSprite)) return;
      if (o.frustumCulled && m.geometry && !frustum.intersectsObject(o)) return;
      const k = name(o);
      out[k] = (out[k] ?? 0) + 1;
    });
    return out;
  }
}

function disposeObject(o: THREE.Object3D) {
  o.removeFromParent();
  o.traverse(c => {
    const m = c as THREE.Mesh;
    if ((m as any).isInstancedMesh) (m as any).dispose();
    else if (m.geometry) m.geometry.dispose();
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
