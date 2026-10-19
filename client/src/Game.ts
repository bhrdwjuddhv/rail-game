import * as THREE from 'three/webgpu';
import { AudioEngine } from './audio/AudioEngine';
import { Ambience } from './audio/Ambience';
import { StationAnnouncer } from './audio/StationAnnouncer';
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
import { AdaptiveResolution } from './core/AdaptiveResolution';
import { Engine } from './core/Engine';
import { textures } from './core/TextureLibrary';
import { prof } from './core/Profiler';
import { bus } from '@rail/shared/events';
import type { RenderSystem } from './core/Renderer';
import { Action, effective, recordScore, settings, trafficLevel, TRAFFIC_LEVELS } from './core/Settings';
import { NO_OVERRIDES, type RecordHost, type RecordRunner } from './record/host';
import { qualityOverride } from './core/Settings';
import type { RecordMode } from './record/RecordMode';
import { formatClock, KMPH, parseClock } from '@rail/shared/util';
import { icon } from './ui/theme/icons';
import { COACHES, JUNCTIONS, LOCOS, locoOrDefault, REGIONS, ROUTES } from './data';
import { JunctionTraffic } from '@rail/shared/traffic/JunctionTraffic';
import { JourneyRun, type JourneyHost } from './routemode/JourneyRun';
import type { ConsistSpec } from '@rail/shared/train/Consist';
import { movingRoads } from './infrastructure/JunctionArchitecture';
import { deadEnds, type DeadEnd } from '@rail/shared/track/TrackGraph';
import { Lighting } from './environment/Lighting';
import { Sky } from './environment/Sky';
import { Horizon } from './world/Horizon';
import { buildHillStation, buildStepwell } from './world/scenery/Landmarks';
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
import { PantoIndicator } from './ui/PantoIndicator';
import { Door, PeopleSystem } from './world/people/People';
import { Billboards, ClickedAd } from './world/scenery/Billboards';
import { AdCard } from './ui/AdCard';
import { StationStop } from './gameplay/StationStop';
import { Wag12Cab } from './train/cab/Wag12Cab';
import { Wag9Cab } from './train/cab/Wag9Cab';
import { PanelCab } from './train/cab/PanelCab';
import { RouteChoice, RoutePicker } from './ui/RoutePicker';
import { DieselSmoke } from './train/Smoke';
import type { DieselTraction } from '@rail/shared/physics/TractionModel';
import type { StationInfo } from '@rail/shared/track/Route';
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
import { buildFort, buildRob, buildYard } from './infrastructure/FreightCorridor';
import { setContactHeight } from './infrastructure/OHE';
import { Gamepad } from './input/Gamepad';
import { enterGameScreen, iosFullscreenTip, isFullscreen, isTouch, syncViewport } from './input/Device';
import { ResumeScreen } from './ui/ResumeScreen';
import { TouchControls } from './ui/TouchControls';
import { Keyboard } from './input/Keyboard';
import { Mouse } from './input/Mouse';
import { LineControl, RailControl } from '@rail/shared/signalling/Control';
import { SignalView } from './signalling/SignalMeshBuilder';
import { Railway } from '@rail/shared/track/Railway';
import { DEFAULT_TRAFFIC, FREIGHT_TRAFFIC, TrafficManager } from '@rail/shared/traffic/TrafficManager';
import { newFrame, RAIL_TOP } from '@rail/shared/track/Chainage';
import { formatGradient } from '@rail/shared/track/Gradient';
import { biomeOf, MIDDLE_LINE, Route, RouteData } from '@rail/shared/track/Route';
import { buildTrackChunk, CHUNK_M, SwitchView } from './track/TrackMeshBuilder';
import { TrackGraph, TrackPath, Ramp } from '@rail/shared/track/TrackGraph';
import { CabControls, CONTROL_NAMES } from './train/cab/CabControls';
import { CabModel, cabLayout } from './train/cab/CabModel';
import { TrainView } from './train/Coach';
import { Consist, Vehicle } from '@rail/shared/train/Consist';
import { LocoSystems } from '@rail/shared/train/LocoSystems';
import { BRAKE_POSITIONS, BrakeSystem } from '@rail/shared/physics/BrakeSystem';
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

/** an AI train in the game: its movement, how it is drawn, and the line view it runs in */
interface AIEntry { train: AITrain; view: TrainView; route: Route; carM: number; side?: number }

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
  private ai: AIEntry[] = [];
  /** scheduled trains on the other line of a double track, coming toward the player */
  private oncoming: TrafficManager | null = null;
  /** Free Roam: trains on the player's own line (overtaking in station loops) */
  private sameLine: TrafficManager | null = null;
  /** big junctions on this route: their own trains coming, standing and going, while the camera is near (centre: world) */
  private junctionTraffic: { jt: JunctionTraffic; centre: THREE.Vector3 }[] = [];
  /** the traffic setting the AI traffic was started with (changed in Settings: restarted) */
  private trafficSetting = -1;
  /** Record Mode (loaded on first use, desktop only): what it overrides, the open studio, and its trains' runner */
  readonly rec = NO_OVERRIDES();
  private record: RecordMode | null = null;
  private recordRunner: RecordRunner | null = null;
  /** Record Mode was used: no scoring for the rest of the run */
  private recordUsed = false;
  /** game keys drive the player's train (off in Record Mode unless "Drive this train") */
  private kbDriving = true;
  /** Record Mode from the main menu: no train of yours (it stands hidden, outside the signalling) */
  private playerHidden = false;
  private setPlayerHidden(on: boolean) {
    if (on === this.playerHidden) return;
    this.playerHidden = on;
    this.trainView.group.visible = !on;
    if (on) { this.lc.remove(this.player); this.dispatcher.resetTrain('player'); }
    else { this.lc.add(this.player); this.pausedNeedsRender = true; }
  }
  /** time warp asked for by a station stop (skipping a wait); the engine runs at warp x Record Mode's world speed */
  private warp = 1;

  /** AI traffic level in force: Record Mode's, or the Settings one (null: none) */
  private trafficLevelNow() {
    const o = this.rec.traffic;
    return o === null ? trafficLevel() : o < 0 ? null : TRAFFIC_LEVELS[Math.min(3, o)];
  }

  /** The rail traffic setting changed: the AI traffic starts over at the new level. */
  private restartTraffic() {
    this.trafficSetting = settings.get().traffic;
    this.oncoming?.reset(); this.oncoming = null;
    this.sameLine?.reset(); this.sameLine = null;
    if (this.railway.double) this.startOncoming();
    this.startJunctions();
  }
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
  /** recorded announcements at the station the train is coming to */
  private announcer: StationAnnouncer | null = null;
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
    this.bench = benchCfg ? new Benchmark(benchCfg, rs, () => this.debugTextures().mb) : null;
    // Free Roam may run on any route
    const routeData = ROUTES[(!scenario.rules && overrides.route && ROUTES[overrides.route] ? overrides.route : null) ?? scenario.route];
    // (the default wire height; a joined route has its own stretch by stretch: Route.contactHeightAt)
    setContactHeight(routeData.oheContactHeightM ?? 5.55);
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
    this.startClock = this.time.run;
    this.weather = new Weather(s.weather);
    this.cameras = new CameraManager(innerWidth / innerHeight, preset.drawDistance + 400);
    this.sky = new Sky(2000);
    this.horizon = new Horizon();
    this.scene.add(this.sky.group, this.horizon.group, this.world);
    this.world.add(this.weather.rainMesh);
    this.lighting = new Lighting(this.scene, this.world);
    this.lighting.applyQuality(preset);
    this.scene.background = new THREE.Color(0x000000);

    // ---- terrain & world ----
    // billboards first: their clear zones go to the terrain workers (no trees or buildings in front of them)
    let adSeed = 7;
    for (const ch of `${this.scenarioId}|${this.route.data.id}|${new Date().toDateString()}`) adSeed = (adSeed * 31 + ch.charCodeAt(0)) >>> 0;
    this.billboards = new Billboards(rs.renderer.domElement, () => this.rcam, this.railway, this.field, adSeed, isTouch || settings.get().quality === 'low');
    this.billboards.onClick = c => this.showAd(c);
    this.adCard = new AdCard(document.body, ad => bus.emit('billboard:visitWebsite', { adId: ad.id }), () => { if (this.adPaused) { this.adPaused = false; this.resume(); } });
    this.chunks = new ChunkManager(this.route, () => effective(), this.billboards.zones);
    this.world.add(this.chunks.root);
    // roadside hoardings with the ads of data/ads.json (click / tap opens the advertiser's site)
    this.world.add(this.billboards.group);
    this.offs.push(() => { this.billboards.dispose(); this.adCard.el.remove(); });
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
    if (settings.get().driving === 'beginner') this.readyToGo();
    const startSt = s.start.atPlatform ? this.line.station(s.start.atPlatform) : undefined;
    // a start beside a platform: at a big junction the running line is a through line with none, so a platform line
    let startLine = s.start.line;
    if (startSt && !startLine) {
      const withPf = new Set(startSt.platforms.flatMap(p => p.lines));
      if (!withPf.has(this.line.running.id)) startLine = startSt.platformLines?.[0] ?? startSt.lineInfo.find(l => withPf.has(l.id) && l.id !== 'ML')?.id;
    }
    const startOffset = startSt?.lineInfo.find(l => l.id === startLine)?.offset ?? this.line.running.offset;
    this.path = new TrackPath(this.line.graph, head, this.dyn.tailKm, startOffset);
    this.plan = planFromTimetable(s.timetable);
    const dyn = this.dyn, plan = this.plan;
    // precedence (loop working): a high-speed trainset first, then passenger trains, goods last
    const goods = this.consist.vehicles.some(v => v.kind === 'coach') && this.consist.vehicles.every(v => v.kind !== 'coach' || (COACHES[v.typeId]?.kind ?? 'coach') !== 'coach');
    const lineMax = Math.max(...routeData.speedLimits.map(l => l.kmph));
    this.player = {
      id: 'player', plan, name: 'your train', player: true,
      priority: loco.trainset ? 4 : goods ? 1 : 3,
      cruiseKmph: Math.min(loco.maxSpeedKmph, lineMax),
      get headKm() { return dyn.headKm; }, get tailKm() { return dyn.tailKm; }, get speed() { return dyn.speed; },
      offsetAt: (km: number) => this.path.offsetAt(km),
    };
    this.lc.add(this.player);
    if (startSt) this.dispatcher.startAt(this.player, startSt.code, this.time.run);
    this.trainView = new TrainView(this.consist.vehicles, loco, COACHES);
    this.world.add(this.trainView.group);
    const layout = cabLayout(loco);
    this.cab = new CabModel(layout);
    this.controls = new CabControls(layout, this.sys, this.dyn.brakes);
    this.cab.group.add(this.controls.group);
    this.trainView.loco.body.add(this.cab.group);
    // a 3D model's own cab can come with a purpose-built interior (shown once the model has loaded)
    const interior = loco.model?.cab?.interior;
    if (interior === 'wag12' || interior === 'wag9') {
      this.modelInterior = interior === 'wag12' ? new Wag12Cab(this.sys, this.dyn.brakes) : new Wag9Cab(this.sys, this.dyn.brakes);
      this.modelInterior.group.visible = false;
      this.trainView.loco.body.add(this.modelInterior.group);
    }
    // a separate console model (bullet train): loaded in the background once the world is up; the
    // game starts outside and moves into the cab when it is ready
    const panel = loco.model?.cab?.interior === 'panel' ? loco.model.cab.panel : undefined;
    if (panel) {
      this.panel = new PanelCab(panel, loco.id, this.sys);
      this.trainView.loco.body.add(this.panel.group);
      this.cameras.index = 4;
      this.wantCab = true;
      this.cameras.gate = i => i !== 0 || this.panelReady();
    }

    // ---- AI trains: scenario trains (km in the data are surveyed km), then traffic on the other line ----
    for (const def of s.aiTrains) {
      const view = this.railway.view(def.track ?? this.line.running.id);
      const d = { ...def, startKm: view.viewKm(def.startKm), despawnKm: view.viewKm(def.despawnKm) };
      this.addAI(new AITrain(d, view, this.ctl.of(view).block), view);
    }
    if (this.railway.double) this.startOncoming();
    this.startJunctions();
    this.startYardMoves();

    // ---- gameplay ----
    this.rules = new Rules(this.line, this.block, this.scoring, this.plan, s.endStation, this.consist.length, s.rules, () => this.god.eff);
    this.scoring.enabled = !this.god.usedThisRun;
    this.offs.push(this.god.onChange(() => this.applyGod()));
    this.scene.add(this.highlight.group);
    this.stop = new StationStop({
      route: () => this.line, consist: this.consist, coachTypes: COACHES, trainView: () => this.trainView, plan: this.plan, endStation: s.endStation,
      headKm: () => this.dyn.headKm, speed: () => this.dyn.speed, offsetAt: km => this.path.offsetAt(km),
      clock: () => this.time.run, setClock: v => { this.time.seconds = v; }, setWarp: x => { this.warp = x; this.engine.speed = x * this.rec.scale; },
      signalAhead: () => this.block.nextSignal(this.dyn.headKm, this.path.offsetAt(this.dyn.headKm), true, this.pathOffset)?.aspect ?? null,
      held: code => this.journey?.holdText(code) ?? null,
      stopTarget: st => this.stopTargetKm(st),
      skipHeld: () => this.journey?.skipWork(),
      approaching: st => (this.noWaitAt === st.code ? null : this.trainToPass(st)),
      skipTrainWait: () => {
        // Skip wait while giving way: the player goes first, the other train stops where it is (short of the
        // station's points) and follows later
        for (const l of this.ctl.lines) l.dispatcher.cancelGiveWay('player');
        const st = this.stop.stationCode ? this.line.station(this.stop.stationCode) : undefined;
        const other = st ? this.trainToPass(st)?.a : undefined;
        if (st && other && other.train.headKm < st.entryKm - 0.05) this.makeWay(other, 'stop');
        this.noWaitAt = this.stop.stationCode ?? '';
        bus.emit('message', { text: 'Not waiting: you leave first, the other train follows you', kind: 'info', ms: 4000 });
      },
      message: (text, kind = 'info') => bus.emit('message', { text, kind, ms: 4000 }),
      whistle: () => { if (this.audio && this.shots) this.shots.guardWhistle(this.audio.buses.station); },
      doorSound: () => { if (this.audio && this.shots) this.shots.doors(this.audio.buses.station); },
      auto: () => this.god.eff.autoDrive, scene: this.world,
    }, ui, () => (isTouch ? null : settings.get().keys.doors.replace(/^Key/, '')));
    this.offs.push(() => this.stop.dispose());
    if (startSt) this.stop.arrive(startSt, true);
    // Route Mode: the journey's card, actions and summary
    this.spec = JSON.parse(JSON.stringify(this.scenario.consist));
    if (overrides.journey) {
      this.journey = new JourneyRun(this.journeyHost(), overrides.journey);
      // a journey's train keeps going: never turned into a loop for another train to pass
      this.player.neverGiveWay = true;
      this.offs.push(() => this.journey?.dispose());
      // the end at a junction: into the arrival bay, up to the buffer stop, when the train fits it
      const end = this.line.station(overrides.journey.to), bay = end?.lineInfo.find(l => l.id === end.bayIn);
      if (end && bay && (bay.toKm - bay.fromKm) * 1000 - 40 > this.consist.length) {
        const p = this.plan.get(end.code);
        this.plan.set(end.code, { ...(p ?? { station: end.code, stop: true }), line: bay.id, stop: true });
        // (the mark: just short of the buffer stop's face, 3.1 m from the line's end: buffered up gently is on it)
        this.endBay = { code: end.code, km: bay.toKm - 0.0046 };
        this.junctionTraffic.find(x => x.jt.j.code === end.code)?.jt.reserveBay(this.line);
      }
    }
    // the player can change line (teleport), so listen on every direction's dispatcher
    for (const l of this.ctl.lines) {
      // departure is given when the stop's work is done (doors closed, loading over), not after a fixed dwell
      // (a Route Mode journey also waits for its planned work there: coaches left or picked up, a loco change)
      l.dispatcher.gates.set('player', code => this.stop.work.ready(code));
      // (and never before the journey's work there is done, even on auto-drive)
      l.dispatcher.holds.set('player', code => !!this.journey?.holds(code));
      l.dispatcher.listeners.push({
        arrived: (t, st, clock) => { if (t.id === 'player' && l === this.lc) { this.rules.arrived(st, clock, this.dyn.headKm); this.stop.arrive(st, false); } },
        departed: (t, st, clock) => { if (t.id === 'player' && l === this.lc) { this.rules.departed(st, !!this.dispatcher.stationState('player', st.code)?.arrived, clock); this.stop.leave(); } },
        // loop working: the dispatcher sets the routes; the player is only told why
        givingWay: (t, st, f) => {
          if (l !== this.lc) return;
          if (t.id === 'player') bus.emit('message', { text: `Routed into the loop at ${st.name}: ${f.name ?? 'a faster train'} will overtake. Wait for the starter signal.`, kind: 'info', ms: 9000 });
          else if (f.id === 'player') bus.emit('message', { text: `${t.name ?? 'A slower train'} is waiting in the loop at ${st.name} for you to pass.`, kind: 'info', ms: 7000 });
        },
        // a change of line out on the open line (Route ahead), given or not
        interchanged: (t, ix, onto) => {
          if (l !== this.lc || t.id !== 'player') return;
          bus.emit('message', { text: onto === 'middle' ? `Points set: onto the middle line ahead (between ${ix.from.name} and ${ix.to.name})` : `Points set: back to your running line ahead`, kind: 'info', ms: 6000 });
        },
        interchangeRefused: (t, _ix, onto) => {
          if (l !== this.lc || t.id !== 'player') return;
          bus.emit('message', { text: onto === 'middle' ? 'No line change: the middle line ahead was not free' : 'No line change: your running line was not clear', kind: 'warn', ms: 6000 });
        },
        overtaking: (t, st, leader, to) => {
          if (l !== this.lc) return;
          if (t.id === 'player') bus.emit('message', { text: `Routed onto the middle line at ${st.name} to overtake ${leader.name ?? 'a slower train'}: back on your line at ${to.name}. Line speed applies on the middle line.`, kind: 'info', ms: 9000 });
          else if (leader.id === 'player') bus.emit('message', { text: `${t.name ?? 'A faster train'} is overtaking you on the middle line.`, kind: 'info', ms: 7000 });
        },
      });
    }

    // ---- cameras ----
    for (const m of [this.cabCam, new FrontCamera(), new RearCamera(), new SideCamera(), new ChaseCamera(), new CinematicCamera(), this.freeCam]) this.cameras.register(m);

    // ---- UI ----
    this.hud = new HUD(ui, () => this.togglePause(false));
    this.profile = new TrackProfile(ui);
    this.minimap = new Minimap(ui, this.route, () => this.line.running.id);
    this.perf = new PerfOverlay(ui, rs);
    // vigilance ACKNOWLEDGE pop-up (desktop shows the key too)
    this.routePicker = new RoutePicker(ui);
    // desktop: an animated pantograph card while P raises / lowers it (touch has its button LED)
    if (!isTouch && loco.type !== 'diesel') this.pantoInd = new PantoIndicator(ui);
    if (loco.type === 'diesel') { this.smoke = new DieselSmoke(); this.world.add(this.smoke.group); }
    this.vigPopup = new VigilancePopup(ui, () => (isTouch ? null : settings.get().keys.vigilance.replace(/^Key/, '')), () => this.sys.acknowledgeVigilance(this.dyn.speed));
    if (isTouch) {
      // the full gauges, track profile and map are pop-ups from the More drawer: tap one to close it
      this.hud.root.querySelector('.hud-panel')!.addEventListener('click', () => { if (this.hud.root.classList.contains('details')) this.hud.toggleDetails(); });
      this.minimap.canvas.addEventListener('click', () => this.minimap.canvas.classList.remove('shown'));
      const game = this;
      this.touch = new TouchControls(ui, {
        // (whichever loco the player drives: their own, or the shunter in Route Mode's Shunt myself)
        get sys() { return game.sys; }, notches: loco.notches,
        brake: () => ({ handle: this.drivenBrakes.handle, independent: this.drivenBrakes.independent }),
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
    this.offs.push(bus.on('needs-engine', e => {
      if (e.action === 'throttle') bus.emit('message', { text: isTouch ? 'Start the engine first: Fuel pump, then Engine (bottom bar)' : 'Start the engine first: U fuel pump, then E engine', kind: 'warn', ms: 2500 });
    }));
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
    window.visualViewport?.addEventListener('resize', this.onResize);
    document.addEventListener('fullscreenchange', this.onFullscreen);
    document.addEventListener('webkitfullscreenchange', this.onFullscreen);
    addEventListener('pageshow', this.onPageShow);
    this.offs.push(() => {
      removeEventListener('resize', this.onResize);
      window.visualViewport?.removeEventListener('resize', this.onResize);
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
    const loco = def.loco && LOCOS[def.loco] ? LOCOS[def.loco] : goods ? locoOrDefault('ep-7') : (LOCOS.wap7 ?? locoOrDefault('ep-7'));
    const carM = def.carLengthM ?? AI_WAGON_LEN;
    const pax = ['icf', 'lhb', 'double-decker'].filter(id => COACHES[id]);
    // a trainset (the bullet train): its own cars, nothing coupled
    const vehicles: Vehicle[] = loco.trainset ? new Consist(loco, COACHES, { loco: loco.id, coaches: [] }).vehicles
      : [{ kind: 'loco', typeId: loco.id, massKg: 0, length: AI_LOCO_LEN, frontOffset: 0, bogieCentres: loco.bogieCentresM, axleSpacing: loco.axleSpacingM, maxBrakeN: 0, davis: { a: 0, b: 0, c: 0 } }];
    let off = AI_LOCO_LEN; // each wagon after the one before it, coupled (no gap, whatever their lengths)
    for (let i = 0; i < def.wagons; i++) {
      // express make-up: general coaches at both ends, sleepers with an AC coach every few
      const type = def.stock ? freightStock(def.stock, i, def.wagons) : goods ? 'goods' : pax[i < 2 || i >= def.wagons - 2 ? 0 : i % 5 === 0 ? Math.min(2, pax.length - 1) : Math.min(1, pax.length - 1)];
      const c = COACHES[type];
      vehicles.push({ kind: 'coach', typeId: type, massKg: 0, length: c.lengthM, frontOffset: off, bogieCentres: c.bogieCentresM, axleSpacing: c.axleSpacingM, maxBrakeN: 0, davis: { a: 0, b: 0, c: 0 } });
      off += c.lengthM;
    }
    const view = new TrainView(vehicles, loco, COACHES, goods ? 'freight' : 'passenger', false);
    this.addCompiled(view.group, () => this.ai.some(a => a.view === view), false);
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
    // the 3D model's geometry is shared by every loco of the type: only procedural parts are freed
    for (const lm of view.locos) lm.group.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh && !m.userData.sharedGeometry) m.geometry.dispose(); });
    view.group.traverse(o => { if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose(); });
  }

  /** Scheduled traffic on the line the player is not on (double line only). */
  private startOncoming() {
    const other = this.ctl.lines.find(l => l !== this.lc);
    if (!other) return;
    let seed = 7;
    const cfg = this.route.data.freight ? FREIGHT_TRAFFIC : DEFAULT_TRAFFIC;
    for (const ch of this.scenarioId + other.route.running.id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    this.trafficSetting = settings.get().traffic;
    const level = this.trafficLevelNow();
    if (!level) return; // Record Mode: traffic off
    const tm = new TrafficManager(other, { ...cfg, seed, headwayS: cfg.headwayS * level.oncoming });
    tm.onSpawn = t => this.addAI(t, other.route);
    tm.onDespawn = t => this.removeAI(t);
    this.oncoming = tm;
    this.startSameLine();
  }

  /**
   * Movement in a big junction's sidings (drawn only, outside the signalling: nothing else uses these
   * roads): a diesel shunter drawing a rake out of the yard and propelling it back, and a light engine
   * running out of the loco shed and back. Head km in the surveyed view; the engine leads towards higher km.
   */
  private yardMoves: { view: TrainView; offset: number; lo: number; hi: number; head: number; target: number; wait: number; v: number; centre: THREE.Vector3 }[] = [];

  private startYardMoves() {
    const lines = this.railway.layout.lines, ends = deadEnds(lines, this.railway.layout.switches, this.route.lengthKm);
    for (const sd of this.route.data.stations) {
      if (!sd.junction) continue;
      const roads = movingRoads(sd.code, lines);
      for (const [id, light] of [[roads.shunt, false], [roads.light, true]] as const) {
        const l = lines.find(x => x.id === id), e = ends.find(d => d.line === id);
        if (!l || !e) continue;
        const loco = light ? (LOCOS['wag-9'] ?? locoOrDefault('ep-7')) : (LOCOS['wdm-3d'] ?? locoOrDefault('ep-7'));
        const wagon = COACHES.boxcar ? 'boxcar' : COACHES.goods ? 'goods' : Object.keys(COACHES)[0];
        const vehicles: Vehicle[] = [{ kind: 'loco', typeId: loco.id, massKg: 0, length: AI_LOCO_LEN, frontOffset: 0, bogieCentres: loco.bogieCentresM, axleSpacing: loco.axleSpacingM, maxBrakeN: 0, davis: { a: 0, b: 0, c: 0 } }];
        let off = AI_LOCO_LEN;
        for (let i = 0; i < (light ? 0 : 6); i++) {
          const c = COACHES[wagon];
          vehicles.push({ kind: 'coach', typeId: wagon, massKg: 0, length: c.lengthM, frontOffset: off, bogieCentres: c.bogieCentresM, axleSpacing: c.axleSpacingM, maxBrakeN: 0, davis: { a: 0, b: 0, c: 0 } });
          off += c.lengthM;
        }
        const L = off / 1000, run = light ? 0.16 : 0.26;
        // the buffer stop end is where it rests; it runs out towards the ladder and back
        const [lo, hi] = e.dir > 0 ? [Math.max(l.fromKm + 0.03 + L, e.km - 0.015 - run), e.km - 0.015] : [e.km + 0.015 + L, Math.min(l.toKm - 0.03, e.km + 0.015 + L + run)];
        const rest = e.dir > 0 ? hi : lo;
        const view = new TrainView(vehicles, loco, COACHES, 'freight', false);
        this.addCompiled(view.group, () => this.yardMoves.some(m => m.view === view), false);
        const f = newFrame();
        this.route.alignment.sampleOffset(rest * 1000, l.offset, f);
        this.yardMoves.push({ view, offset: l.offset, lo, hi, head: rest, target: rest, wait: 8 + Math.random() * 20, v: 0, centre: new THREE.Vector3(f.x, f.y, f.z) });
      }
    }
  }

  /** Shunter and light engine: run to the other end of their road at walking pace, stand a while, come back. */
  private updateYardMoves(dt: number, night: number, cam: THREE.Vector3) {
    for (const m of this.yardMoves) {
      const near = m.centre.distanceTo(cam) < 3000;
      m.view.group.visible = near;
      if (!near) continue;
      if (m.wait > 0) m.wait -= dt;
      else {
        const left = (m.target - m.head) * 1000, dir = Math.sign(left);
        m.v = Math.min(2.8, m.v + 0.3 * dt, Math.sqrt(2 * 0.25 * Math.abs(left)));
        const step = Math.min(Math.abs(left), m.v * dt);
        m.head += (dir * step) / 1000;
        if (Math.abs(left) < 0.05) { m.v = 0; m.wait = 25 + Math.random() * 40; m.target = Math.abs(m.target - m.lo) < 1e-6 ? m.hi : m.lo; }
      }
      m.view.update(this.route, m.head, () => m.offset, m.head * 1000, night);
      m.view.loco.setLights(night > 0.3 ? 2 : 1, true, false, this.t, 1);
    }
  }

  /**
   * Beginner driving controls: the loco ready to go (the tutorial still starts it from cold): a diesel's fuel
   * pump on and engine running, an electric's pantograph up on the wire and breaker closed; brakes released
   * and charged; reverser forward; headlight on.
   */
  private readyToGo() {
    const s = this.sys, b = this.dyn.brakes;
    b.handle = BRAKE_POSITIONS.indexOf('Running');
    b.er = 5; b.bp.fill(5); b.bc.fill(0); b.independent = 0;
    if (s.isDiesel) { s.fuelPump = true; s.engine = 'running'; s.engineRpm = s.loco.diesel?.idleRpm ?? 400; }
    else { s.pantoUp = true; s.pantoPos = 1; s.vcb = true; }
    s.setReverser(1);
    s.headlight = 1;
  }

  /** Shunt myself: the player's own loco systems while their controls drive the shunter's, and the shunter's brakes */
  private ownSys: LocoSystems | null = null;
  private shunterBrakes: BrakeSystem | null = null;
  /** the brakes the player's handles work: their train's, or the shunter's */
  private get drivenBrakes() { return this.shunterBrakes ?? this.dyn.brakes; }

  /** the camera to come back to after watching the shunting */
  private camBeforeShunt = 0;
  /** the station where the player chose not to wait for a train to pass (Skip wait) */
  private noWaitAt = '';
  /** Route Mode ending at a junction: the train runs into the bay to the buffer stop (head km there) */
  private endBay: { code: string; km: number } | null = null;

  /** Route Mode: the running journey (null otherwise), and the train as specified now (coupling changes it) */
  private journey: JourneyRun | null = null;
  private spec!: ConsistSpec;

  private journeyHost(): JourneyHost {
    const st = (code: string) => this.dispatcher.stationState('player', code);
    return {
      route: () => this.line,
      head: () => this.dyn.headKm, tail: () => this.dyn.tailKm, speed: () => this.dyn.speed,
      setSpeed: v => { this.dyn.speed = v; },
      offsetAt: km => this.path.offsetAt(km),
      vehicles: () => this.consist.vehicles,
      spec: () => this.spec,
      rebuildTrain: spec => this.rebuildTrain(spec),
      arrived: code => !!st(code)?.arrived, departed: code => !!st(code)?.departed,
      stopKm: code => { const s = this.line.station(code); return s ? this.stopTargetKm(s) : null; },
      showLoco: on => { for (const l of this.trainView.locos) l.group.visible = on; },
      lc: () => this.lc,
      manual: id => this.dispatcher.manual.add(id),
      world: this.world, ui: this.ui,
      addCompiled: o => this.addCompiled(o, () => !!o.parent, false),
      freeCam: (eye, target) => {
        if (this.cameras.index !== 6) { this.camBeforeShunt = this.cameras.index; this.cameras.select(6, this.cameraContext(0.016)); }
        this.freeCam.place(eye, target);
      },
      restoreCamera: () => this.cameras.select(this.camBeforeShunt, this.cameraContext(0.016)),
      setPlan: (code, stop, dwellS) => { if (stop) this.plan.set(code, { station: code, line: this.plan.get(code)?.line ?? '', stop: true, dwellS }); else this.plan.delete(code); },
      continueWith: j => {
        this.menus.loading('Changing the locomotive', 0.5);
        try { sessionStorage.setItem('railbharat.autostart', JSON.stringify({ id: 'route-mode', overrides: { journey: j } })); } catch { /* ignore */ }
        location.reload();
      },
      finish: s => {
        if (this.ended) return;
        this.ended = true;
        setTimeout(() => {
          this.engine.paused = true;
          this.keyboard.enabled = false;
          this.menus.journeyReport(s, { restart: () => this.restart(), quit: () => Game.quit() });
        }, 2500);
      },
      message: (text, kind = 'info') => bus.emit('message', { text, kind, ms: 5000 }),
      clock: () => this.time.run,
      inCab: () => !!this.cameras.mode.inCab,
      driveCam: on => {
        if (on) { this.camBeforeShunt = this.cameras.index; this.cameras.select(0, this.cameraContext(0.016)); }
        else this.cameras.select(this.camBeforeShunt, this.cameraContext(0.016));
      },
      secure: () => { this.sys.setThrottle(0); this.sys.regen = 0; this.dyn.brakes.independent = 1; },
      takeControls: loco => {
        // the shunter's own systems: engine running, fuel pump on, brakes off, reverser in the middle (ready to go)
        const b = new BrakeSystem(new Consist(loco, COACHES, { loco: loco.id, coaches: [] }).vehicles);
        b.handle = BRAKE_POSITIONS.indexOf('Running'); b.independent = 0;
        const s = new LocoSystems(loco, b);
        if (s.isDiesel) { s.fuelPump = true; s.engine = 'running'; s.engineRpm = loco.diesel?.idleRpm ?? 400; }
        s.headlight = 1;
        this.ownSys ??= this.sys;
        this.sys = s;
        this.shunterBrakes = b;
      },
      shunterLevers: (dir, braking) => {
        const b = this.shunterBrakes;
        if (!b || !this.ownSys) return;
        if (dir) this.sys.setReverser(dir as -1 | 1);
        this.sys.notch = dir && !braking ? Math.min(4, this.sys.loco.notches) : 0;
        b.independent = braking || !dir ? 1 : 0;
      },
      returnControls: () => {
        if (this.ownSys) this.sys = this.ownSys;
        this.ownSys = null;
        this.shunterBrakes = null;
      },
    };
  }

  /**
   * The train changed at a stop (Route Mode: coaches coupled on or left behind; the same loco). Physics,
   * brakes, the drawn train (the cab moves to the new view's loco), the stop work and the rules follow.
   */
  private rebuildTrain(spec: ConsistSpec) {
    const loco = this.consist.loco;
    const consist = new Consist(loco, COACHES, spec);
    this.spec = spec;
    this.dyn.setConsist(consist);
    this.consist = consist;
    const old = this.trainView, tv = new TrainView(consist.vehicles, loco, COACHES);
    for (const g of [this.cab.group, this.modelInterior?.group, this.panel?.group]) if (g && g.parent === old.loco.body) tv.loco.body.add(g);
    old.group.removeFromParent();
    for (const lm of old.locos) lm.group.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh && !m.userData.sharedGeometry) m.geometry.dispose(); });
    old.group.traverse(o => { if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose(); });
    this.trainView = tv;
    this.world.add(tv.group);
    this.stop.setConsist(consist);
    this.rules = new Rules(this.line, this.block, this.scoring, this.plan, this.scenario.endStation, consist.length, this.scenario.rules, () => this.god.eff);
  }

  /** when the departure boards were last redrawn (s, run time) */
  private boardsAt = -10;

  /** The junctions' departure boards: their passenger trains due, standing or leaving, soonest first. */
  private updateDepartureBoards() {
    const hhmm = (sec: number) => { const m = Math.floor(sec / 60); return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
    for (const { jt } of this.junctionTraffic) {
      const sv = this.stations.get(jt.j.code);
      if (!sv) continue;
      const rows: { time: string; name: string; pf: string; status: string; eta: number }[] = [];
      for (const t of jt.trains) {
        const info = jt.info.get(t), lc = this.ctl.lines.find(l => l.trains.includes(t)), st = lc?.route.station(jt.j.code);
        if (!info || info.passing || !st || t.tailKm > st.platformToKm) continue;
        const pf = info.line ? (st.numbers?.[info.line] ?? info.line.replace(/^P/, '')) : '--';
        let eta = 0, status: string;
        if (t.headKm < st.platformFromKm) { eta = ((st.platformFromKm - t.headKm) * 1000) / Math.max(t.speed, 12); status = eta < 150 ? 'ARRIVING' : 'ON TIME'; }
        else status = t.speed < 0.5 ? 'ON PLATFORM' : t.headKm > st.km ? 'DEPARTING' : 'ARRIVING';
        rows.push({ time: hhmm(this.time.seconds + eta), name: info.name, pf, status, eta });
      }
      sv.setDepartures(rows.sort((a, b) => a.eta - b.eta));
    }
  }

  /** The big junctions' own traffic (both directions; at least three trains there whenever you are). */
  private startJunctions() {
    for (const { jt } of this.junctionTraffic) jt.reset();
    this.junctionTraffic = [];
    if (!this.trafficLevelNow() || this.bench) return;
    const bullet = LOCOS['bullet-train'];
    for (const sd of this.route.data.stations) {
      const j = sd.junction && JUNCTIONS[sd.junction.id];
      if (!j) continue;
      let seed = 13;
      for (const ch of this.scenarioId + j.id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
      // phones and Low quality: fewer trains (still three standing and one moving)
      const few = isTouch || settings.get().quality === 'low';
      const jt = new JunctionTraffic(this.ctl, j, { seed, inStation: few ? Math.min(3, j.trainsInStation) : j.trainsInStation, bullet: j.bullet && bullet ? { loco: bullet.id, lengthM: bullet.lengthM } : null });
      jt.onSpawn = (t, v) => this.addAI(t, v);
      jt.onDespawn = t => { const a = this.ai.find(x => x.train === t); if (a) this.ctl.of(a.route).remove(t); this.removeAI(t); };
      const f = newFrame();
      this.route.alignment.sample(sd.km * 1000, f);
      this.junctionTraffic.push({ jt, centre: new THREE.Vector3(f.x, f.y, f.z) });
    }
  }

  /**
   * Free Roam: traffic on the player's own line too (same direction): faster
   * trains come up from behind and overtake where the dispatcher turns the
   * slower train (the player's or theirs) into a loop. Scenarios keep their own trains.
   */
  private startSameLine() {
    this.sameLine?.reset();
    this.sameLine = null;
    // own-line traffic: always in Free Roam; in scenarios from Medium traffic up
    const level = this.trafficLevelNow();
    if (!level || this.bench || (this.scenario.rules && !level.inScenarios)) return;
    let seed = 11;
    for (const ch of this.scenarioId + this.lc.route.running.id + 'same') seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const base = this.route.data.freight ? FREIGHT_TRAFFIC : DEFAULT_TRAFFIC;
    const tm = new TrafficManager(this.lc, { ...base, seed, headwayS: base.headwayS * level.sameLine, aheadKm: 8, sameLine: { playerKmph: this.player.cruiseKmph ?? 100 } });
    tm.onSpawn = t => this.addAI(t, this.lc.route);
    tm.onDespawn = t => this.removeAI(t);
    this.sameLine = tm;
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
    this.sameLine?.reset(); this.sameLine = null;
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
    // freight corridor: road over-bridges, container depot / port, hill forts
    for (const r of this.route.data.structures) if (r.type === 'rob') add(r.fromKm, r.toKm + 0.4, () => buildRob(this.route, this.field, r));
    for (const y of this.route.yards) add(y.fromKm, y.toKm, () => buildYard(this.route, y), undefined, ['wall']);
    // billboards: one group per km of line
    for (const b of this.billboards.buckets) add(b, b + 1, () => this.billboards.build(b), () => this.billboards.release(b));
    for (const ft of this.route.data.features) if (ft.type === 'fort') add(ft.km - 0.9, ft.km + 0.9, () => buildFort(this.route, this.field, ft.km), undefined, ['wall']);
    // landmarks: step-wells near villages, ghat hill stations
    for (const ft of this.route.data.features) {
      if (ft.type === 'stepwell') add(ft.km - 0.3, ft.km + 0.3, () => buildStepwell(this.route, this.field, ft));
      if (ft.type === 'hillstation') add(ft.km - 0.6, ft.km + 0.6, () => buildHillStation(this.route, this.field, ft), undefined, ['wall', 'roof']);
    }
    for (const st of this.route.stations) {
      add(st.platformFromKm, st.platformToKm, () => { const v = new StationView(this.route, st, this.railway.layout); v.crowd.mesh.visible = !this.people?.ready; this.stations.set(st.code, v); return v.group; },
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
    this.warmShadows();
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

  async begin(opts: { tutorial?: boolean; record?: boolean } = {}) {
    enterGameScreen(); // phones: fullscreen + landscape lock, inside the Start tap
    if (this.audio) {
      this.audio.resume();
      this.shots = new OneShots(this.audio);
      this.trainAudio = new TrainAudio(this.audio, this.shots, this.consist.loco, this.consist.coachCount);
      this.ambience = new Ambience(this.audio, this.shots);
      this.announcer = new StationAnnouncer(this.audio);
      this.offs.push(() => this.announcer?.dispose());
      await this.trainAudio.init();
    }
    // canvas size and pixel ratio set once, before the first frame (a resize clears the canvas)
    this.applySettings();
    this.wasFullscreen = isFullscreen();
    if (this.bench) this.prepareForBench();
    this.engine.paused = false;
    this.started = true;
    // from now on new terrain tiles compile their shaders before they are shown
    this.chunks.prepare = g => this.rs.renderer.compileAsync(g, this.rcam, this.scene);
    this.rs.renderer.setAnimationLoop(t => this.engine.tick(t));
    // the loading screen stays on top until real frames are on the canvas (and, on phones, until the
    // fullscreen / landscape switch has settled), then fades out: no blank or half-sized flash
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (isTouch && !this.bench) await sleep(350);
    this.menus.inGame = true;
    if (this.bench) this.menus.hide(); else await this.menus.reveal();
    this.startPeople();
    if (this.panel) this.panelReady();
    // the game screen is showing: lay out for its real size now, and again once fullscreen / rotation has settled
    this.onResize();
    setTimeout(this.onResize, 350);
    if (isTouch) iosFullscreenTip(document.body);
    const s = this.scenario;
    bus.emit('message', { text: `${s.name} - ${WEATHER[s.weather].name}, ${formatClock(this.time.seconds)}`, kind: 'info', ms: 6000 });
    bus.emit('message', { text: isTouch ? 'Prepare the loco: raise the pantograph (bottom bar), close the main breaker (\u22ef), reverser F, then the BRAKE lever up and THROTTLE up.' : 'Prepare the loco: P pantograph, O main breaker, ; release brakes, W reverser forward. F1 for help.', kind: 'info', ms: 12000 });
    if (s.timetable[0]?.dep) bus.emit('message', { text: `Departure ${s.timetable[0].dep} from ${this.route.station(s.timetable[0].station)?.name}. Wait for the starter signal.`, kind: 'info', ms: 12000 });
    this.applyGod();
    // started from the main menu's Record Mode: straight into the studio, no train of yours
    if (opts.record && !isTouch && !this.bench) { this.setPlayerHidden(true); await this.enterRecord(); return; }
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
    this.scoring.enabled = !g.usedThisRun && !this.tutorialPractice && !this.recordUsed;
    if (g.active && e.weather && e.weather !== this.weather.id) this.weather.set(e.weather, true);
    this.syncStops();
    // manual points: the player's routes are not set automatically (existing ones are cancelled)
    const manual = this.dispatcher.manual.has('player');
    if (e.manualPoints && !manual) { this.dispatcher.manual.add('player'); this.interlocking.releaseTrain('player'); }
    else if (!e.manualPoints && manual) this.dispatcher.manual.delete('player');
    this.touch?.setRouting(!this.scenario.rules, e.manualPoints);
  }

  // ------------------------------------------------------------------ routes
  /** Next interlocked station ahead whose points can still be changed for this train. */
  private stationAhead(): StationInfo | undefined {
    const head = this.dyn.headKm;
    return this.line.stations.find(s => s.type !== 'halt' && s.entryKm > head + 0.35 && s.lineInfo.length > 1);
  }

  /** Name of a line at a station as a driver would say it. */
  private lineLabel(st: StationInfo, id: string) {
    const pf = st.platforms.find(p => p.lines.includes(id));
    if (id === MIDDLE_LINE) return 'Middle line (no platform)';
    if (id === this.line.running.id) return `Main line (${id})${pf ? ` - Platform ${pf.num}` : ''}`;
    return `Loop ${id}${pf ? ` - Platform ${pf.num}` : ""}`;
  }

  /**
   * Free Roam "Route ahead": pick the line to be received on at the next
   * station. The interlocking sets it when the points are free (scenarios
   * follow their route plan).
   */
  private openRouteAhead() {
    if (this.routePicker.open) { this.routePicker.hide(); return; }
    if (this.scenario.rules) { bus.emit('message', { text: 'In scenarios the route follows the timetable plan', kind: 'info' }); return; }
    const st = this.stationAhead();
    // an interchange on the open line before the next station: change between the running and middle lines there
    const head = this.dyn.headKm, onMiddle = Math.abs(this.path.offsetAt(head)) < 1;
    const ix = this.line.interchanges.find(x => this.line.graph.byId.get(onMiddle ? x.off : x.on)!.def.rampStart > head + 0.15 && (!st || x.km < st.entryKm));
    if (ix) {
      const wanted = this.dispatcher.interchangeWanted.get('player');
      const here = onMiddle ? 'middle' : 'running', other = onMiddle ? 'running' : 'middle';
      const label = (k: string) => (k === 'middle' ? 'Middle line' : `Running line (${this.line.running.id})`);
      const choices: RouteChoice[] = [here, other].map(k => ({ id: k, label: k === here ? `Stay on the ${label(k).toLowerCase()}` : `Change to the ${label(k).toLowerCase()}`, current: (wanted?.ix === ix ? wanted.onto : here) === k }));
      this.routePicker.show(`Interchange, ${(this.line.canonicalKm(ix.km)).toFixed(1)} km`, choices, id => {
        if (id === here) { this.dispatcher.interchangeWanted.delete('player'); return; }
        this.dispatcher.interchangeWanted.set('player', { ix, onto: id as 'middle' | 'running' });
        bus.emit('message', { text: `Line change asked for at the interchange ahead: set when ${id === 'middle' ? 'the middle line is free' : 'your line is clear'}`, kind: 'info' });
      });
      return;
    }
    if (!st) { bus.emit('message', { text: 'No junction or loop ahead to route into', kind: 'info' }); return; }
    const cur = this.player.plan.get(st.code)?.line || this.line.running.id;
    const choices: RouteChoice[] = st.lineInfo.map(l => ({ id: l.id, label: this.lineLabel(st, l.id), current: l.id === cur }));
    this.routePicker.show(st.name, choices, id => {
      const ok = this.dispatcher.reroute(this.player, st, id);
      bus.emit('message', ok ? { text: `Route requested: ${this.lineLabel(st, id)} at ${st.name}`, kind: 'info' } : { text: `Too late to change the route at ${st.name}`, kind: 'warn' });
    });
  }

  /**
   * Diesel exhaust from every diesel unit's stack: dark puffs while cranking
   * and when the engine is notched up (turbo still catching up), a light haze
   * at steady power, nothing when stopped.
   */
  private updateSmoke(dt: number) {
    if (!this.smoke) return;
    const s = this.sys, tr = this.dyn.traction as DieselTraction;
    const rise = Math.max(0, (s.engineRpm - this.lastRpm) / Math.max(dt, 1e-3));
    this.lastRpm = s.engineRpm;
    const demand = s.notch / this.consist.loco.notches;
    const dark = s.engine === 'cranking' ? 0.95 : Math.min(1, 0.1 + rise / 220 + Math.max(0, demand - tr.load) * 1.4);
    const rate = s.engine === 'stopped' ? 0 : s.engine === 'cranking' ? (s.engineRpm > 60 ? 9 : 0) : 2.5 + tr.load * 9 + dark * 8;
    const w = this.weather.p.wind;
    const wind = new THREE.Vector3(w * 1.4, 0, w * 0.6);
    const lm = this.trainView.locos.find(m => m.stack);
    const pos = lm ? this.world.worldToLocal(lm.body.localToWorld(lm.stack!.clone())) : null;
    this.smoke.update(dt, pos, rate, dark, wind);
  }

  /** God Mode manual points: throw the next unlocked switch ahead (never under a train). */
  private throwNextPoints() {
    if (!this.dispatcher.manual.has('player')) { bus.emit('message', { text: 'Turn on Manual points in God Mode first', kind: 'info' }); return; }
    const head = this.dyn.headKm;
    const sw = this.line.graph.switches.find(s => s.def.rampStart > head + 0.02 && s.def.rampStart < head + 3 && !s.locked);
    if (!sw) { bus.emit('message', { text: 'No free points within 3 km ahead', kind: 'info' }); return; }
    const onIt = this.ctl.occupantsFor(this.lc).some(o => o.headKm > sw.def.rampStart - 0.02 && o.tailKm < sw.def.rampEnd + 0.02);
    if (onIt) { bus.emit('message', { text: 'A train is on those points', kind: 'warn' }); return; }
    sw.state = sw.state === 'normal' ? 'reverse' : 'normal';
    bus.emit('message', { text: `Points ${sw.def.id} thrown ${sw.state}`, kind: 'info' });
  }

  /** "Route set: Platform 2 at Rampur Jn" once the player's route into a station is set off the main line. */
  private announceRoute() {
    const st = this.line.stations.find(s => s.exitKm > this.dyn.headKm && s.type !== 'halt');
    const r = st ? this.interlocking.reception(st) : undefined;
    const key = r && r.trainId === 'player' && r.set ? `${st!.code}:${r.lineId}` : '';
    if (!key || key === this.routeNote) return;
    this.routeNote = key;
    if (r!.lineId !== this.line.running.id || this.player.plan.get(st!.code)?.line) {
      bus.emit('message', { text: `Route set: ${this.lineLabel(st!, r!.lineId)} at ${st!.name}`, kind: 'info', ms: 4500 });
    }
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
      regions: Object.values(REGIONS).map(r => ({ id: r.id, name: r.name })),
      sceneryPreview: () => this.sceneryPreview,
      setSceneryPreview: id => this.setSceneryPreview(id),
      teleport: target => { void this.teleportTo(target); },
      back, resume: () => this.resume(),
      textureTest: () => this.openTextureTest(),
      bugCameras: BUG_CAMERAS[this.route.data.id] ?? [],
      bugCamera: id => { void this.bugCamera(id); },
      billboards: {
        routeName: this.route.data.name,
        stats: this.billboards.stats,
        report: () => this.billboards.report(),
        markers: () => !!this.minimap.markers,
        setMarkers: on => {
          this.billboards.showMarkers(on);
          const colour = { ok: '#3ad16b', moved: '#ffc83a', dropped: '#ff4a3a' };
          this.minimap.markers = on ? [...this.billboards.slots, ...this.billboards.dropped].map(s => ({ x: s.x, z: s.z, color: colour[s.status] })) : null;
          this.pausedNeedsRender = true;
        },
        reload: () => this.billboards.reload(),
        jumpNext: () => this.jumpToBillboard(),
        house: () => this.billboards.houseCounts,
        sampleAds: () => Billboards.sampleAds,
        setSampleAds: on => { Billboards.sampleAds = on; return this.billboards.reload(); },
      },
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
  /** the 3D model's own cab is in use (our procedural cab hidden) */
  private modelCabShown = false;
  /** interior built for a loco model's own cab (WAG-12B) */
  private modelInterior: Wag12Cab | Wag9Cab | null = null;
  private horizon: Horizon;
  private air = { haze: 1, clouds: 0, tint: new THREE.Color(), tintW: 0 };
  private tmpColor = new THREE.Color();
  private panel: PanelCab | null = null;
  /** the cab view was asked for while the console was loading: switch when it is ready */
  private wantCab = false;

  /** The console is loaded; otherwise start loading it (once), say so, and switch to the cab when done. */
  private panelReady() {
    const p = this.panel!;
    if (p.ready) return true;
    if (this.started && !this.wantCab) bus.emit('message', { text: 'Loading cab\u2026', kind: 'info', ms: 2500 });
    this.wantCab = true;
    void p.load(o => this.rs.renderer.compileAsync(o, this.rcam, this.scene)).then(ok => {
      if (ok && this.wantCab) { this.wantCab = false; this.cameras.select(0, this.cameraContext(0.016)); }
    });
    return false;
  }

  /** Driver's eye in the loco body frame: the model's own cab seat, or our cab's. */
  private cabEye() {
    const c = this.trainView.loco.usesModelCab ? this.consist.loco.model!.cab! : null;
    return c ? new THREE.Vector3(...c.eye) : cabLayout(this.consist.loco).eye;
  }
  private vigPopup!: VigilancePopup;
  private pantoInd: PantoIndicator | null = null;
  /** platform crowds from the baked people models (null: WebGL only; stations keep their simple crowd until it is ready) */
  private people: PeopleSystem | null = null;
  private billboards!: Billboards;
  private adCard!: AdCard;
  /** paused for a billboard's card (resumed when it closes) */
  private adPaused = false;

  /** God Mode: the free camera at a driver's view of the next billboard ahead of the last one looked at (or of the train). */
  private bbJumpS = -1;
  private jumpToBillboard() {
    const slots = this.billboards.slots.filter(s => s.type !== 'platform' && s.type !== 'fob').sort((a, b) => a.s - b.s);
    if (!slots.length) return;
    const from = this.bbJumpS >= 0 ? this.bbJumpS : this.line.canonicalKm(this.dyn.headKm) * 1000;
    const sl = slots.find(s => s.s > from + 1) ?? slots[0];
    this.bbJumpS = sl.s;
    // from 150 m before it on the line whose trains it faces, at cab height
    const a = this.railway.main.alignment, f = newFrame(), dir = sl.side < 0 ? -1 : 1;
    a.sampleOffset(sl.s + dir * 150, sl.side * this.route.halfSpacing, f);
    const ctx = this.cameraContext(0.016);
    this.cameras.select(6, ctx);
    this.freeCam.place(new THREE.Vector3(f.x, f.y + 3.8, f.z), new THREE.Vector3(sl.x, sl.y + 5, sl.z));
    this.pausedNeedsRender = true;
    bus.emit('message', { text: `Billboard ${sl.id}: ${sl.type} at km ${(sl.s / 1000).toFixed(2)} (${sl.status})`, kind: 'info', ms: 4000 });
  }

  /** A billboard was clicked or tapped: pause and show its card (only its "Visit website" opens the link). */
  private showAd(c: ClickedAd) {
    if (this.ended || !this.started || this.adCard.visible || this.record) return;
    if (!this.engine.paused) {
      this.adPaused = true;
      this.engine.paused = true;
      this.keyboard.enabled = false;
      this.mouse.enabled = false;
      this.audio?.fadeOut();
    }
    this.adCard.show(c.ad, c.image);
  }
  /** the player's station stops: doors, boarding, loading, and when the train may leave */
  private stop!: StationStop;
  private doorHintAt = -Infinity;
  private adaptiveRes = new AdaptiveResolution(isTouch ? 0.5 : 0.6);
  private appliedScale = 1;
  private routePicker!: RoutePicker;
  /** diesel exhaust (null for electric locos) */
  private smoke: DieselSmoke | null = null;
  private lastRpm = 0;
  /** last announced route ("station:line") */
  private routeNote = '';
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
    this.stop.leave();
    if (st) this.dispatcher.startAt(this.player, st.code, this.time.run);
    this.path = new TrackPath(L.graph, km, d.tailKm, L.running.offset);
    this.oncoming?.reset();
    this.sameLine?.reset();
    this.rules.callingOnUntil = -1;
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
  /** Start (or restart) the "how to start the train" tutorial (the diesel one on a diesel) in the cab at a station. */
  async startTutorial() {
    // beginner controls: how to drive (the loco ready to go); advanced: the whole start-up from cold (diesel or electric)
    const beginner = settings.get().driving === 'beginner';
    const data = TUTORIALS[beginner ? 'drive-beginner' : this.sys.isDiesel ? 'start-diesel' : 'start-train'];
    if (!data) return;
    this.stopTutorial(false);
    const head = this.dyn.headKm;
    const atStation = this.line.stations.find(s => head >= s.platformFromKm && head <= s.platformToKm + 0.05);
    if (!atStation || Math.abs(this.dyn.speed) > 0.1) {
      const nearest = [...this.line.stations].sort((a, b) => Math.abs(a.km - head) - Math.abs(b.km - head))[0];
      await this.teleportTo({ station: nearest.code });
    }
    if (this.engine.paused) this.resume();
    const s = this.sys, b = this.dyn.brakes;
    s.setThrottle(0); s.regen = 0;
    if (beginner) this.readyToGo();
    else {
      // cold loco: pantograph down, breaker open, lights off, reverser neutral, brakes on
      if (s.pantoUp) s.togglePanto();
      // a diesel starts dead: engine stopped, fuel pump off
      if (s.isDiesel && s.engine !== 'stopped') s.toggleEngine();
      if (s.isDiesel && s.fuelPump) s.toggleFuelPump();
      s.headlight = 0;
      s.setReverser(0);
      s.setTrainBrake(BRAKE_POSITIONS.indexOf('Full Service'));
      b.independent = 1;
    }
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
    this.applyGod();
  }

  /** What a rigged cab's parts follow (LocoRigPart.drive). */
  private rigValues() {
    const s = this.sys, d = this.dyn, b = d.brakes;
    return {
      notch: s.notch, regen: s.regen, controller: s.notch > 0 ? s.notch / s.loco.notches : -s.regen / s.loco.regen.notches,
      reverser: s.reverser, trainBrake: b.handle / (BRAKE_POSITIONS.length - 1), locoBrake: b.independent,
      headlight: s.headlight, horn: s.hornLow || s.hornHigh ? 1 : 0, speed: Math.abs(d.speedKmph), bp: b.locoBP, bc: b.locoBC, mr: b.mr,
      flow: Math.max(0, b.er - b.locoBP), amps: d.traction.motorCurrent, rpm: s.engineRpm,
      engine: s.engine === 'running' ? 1 : s.engine === 'cranking' ? 0.5 : 0, fuelPump: s.fuelPump ? 1 : 0,
      fuelPressure: s.fuelPump ? (s.engine === 'running' ? 4 + 2 * (s.notch / s.loco.notches) : 3) : 0,
      cabLight: s.cabLight ? 1 : 0, flasher: s.flasher ? 1 : 0,
      // lamps: brakes on, an alarm (wheel slip, overspeed, the vigilance warning)
      brakeOn: b.locoBC > 0.3 ? 1 : 0, alert: d.traction.slipping || s.overspeed || s.vigilanceState !== 'ok' ? 1 : 0, sander: s.sander ? 1 : 0,
    };
  }

  /** a cab control's part (what the tutorial points at): the model's own rigged cab, or ours */
  private controlAnchor(id: string) {
    const rig = this.trainView.loco.rig;
    return rig ? rig.anchor(id) : this.controls.anchor(id);
  }

  private setTutorialHighlight(id: string | null) {
    this.hudPulse?.classList.remove('tut-pulse');
    this.hudPulse = null;
    if (!id) { this.highlight.set(null); return; }
    if (id === 'hud:limit') {
      this.hudPulse = document.querySelector('.hud-panel .limit');
      this.hudPulse?.classList.add('tut-pulse');
      this.highlight.set(this.controlAnchor('display'), 0.12);
      return;
    }
    if (id === 'signal') {
      const sig = this.block.nextSignal(this.dyn.headKm, this.path.offsetAt(this.dyn.headKm), true, this.pathOffset);
      const v = sig ? this.signalViews.get(sig.id) : undefined;
      this.highlight.set(v ? v.group : null, 1.6, 6.5);
      return;
    }
    this.highlight.set(this.controlAnchor(id), id.startsWith('gauge:') ? 0.11 : 0.08);
  }

  /** "Show me": point the cab camera at the step's control (or its gauge). */
  private tutorialShowMe() {
    const step = this.tutorial?.step;
    if (!step) return;
    if (this.cameras.index !== 0) this.cameras.select(0, this.cameraContext(0.016));
    const target = step.showMe ?? step.highlight;
    if (!target || target === 'signal' || target === 'hud:limit') { this.cabCam.yaw = 0; this.cabCam.pitch = -0.05; return; }
    const a = this.controlAnchor(target);
    if (!a) return;
    const p = a.getWorldPosition(new THREE.Vector3());
    this.trainView.loco.body.worldToLocal(p);
    const eye = this.cabEye();
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
      fuelPump: s.fuelPump, engineRunning: s.engine === 'running',
    };
  }

  /**
   * Platform crowds: models load in the background once the run has started
   * (never on the loading screen, never all in one frame). Budget by quality:
   * High 90, Medium 60, Low and phones 20.
   */
  private startPeople() {
    // benchmarks leave crowds out unless asked (?people=1)
    if (this.rs.kind !== 'webgl' || (this.bench && !new URLSearchParams(location.search).has('people'))) return;
    const q = settings.get().quality;
    // High was 150: on an Intel UHD that cost 9 % of the frame at a junction; 90 costs 2 % (PERF_LOG 2026-10-11)
    const budget = isTouch || q === 'low' ? 20 : q === 'medium' ? 60 : 90;
    this.people = new PeopleSystem(this.route, this.rs.renderer as unknown as ConstructorParameters<typeof PeopleSystem>[1], budget, isTouch ? 0.6 : 1);
    this.world.add(this.people.group);
    void this.people.load(this.rcam, this.scene).then(ok => { if (ok) for (const v of this.stations.values()) v.crowd.mesh.visible = false; });
  }

  /**
   * A train that will pass the player's while it stands in a loop at `st`:
   * the nearest AI train on the same running line, not yet past the station.
   */
  private trainToPass(st: StationInfo) {
    const off = this.path.offsetAt(this.dyn.headKm);
    if (Math.abs(off - this.line.running.offset) < 0.5) return null; // on the main line: nothing can pass
    let best: { name: string; km: number; a: AIEntry } | null = null;
    for (const a of this.ai) {
      if (a.route !== this.line || a.train.gone || this.madeWay.has(a.train)) continue;
      const km = st.platformToKm - a.train.headKm;
      if (km > 0 && km < 25 && (!best || km < best.km)) best = { name: a.train.def.name, km, a };
    }
    return best;
  }

  /** AI trains made to stand aside for the player (Skip wait / Skip signal): left alone by the dispatcher until then (run clock) */
  private madeWay = new Map<AITrain, number>();

  /**
   * Out of the player's way: the train stops where it is (`stop`), or moves across onto the middle line where
   * that is free (`middle`; claimed there, the other direction shares it). Its routes are given up and the
   * dispatcher leaves it alone for a while.
   */
  private makeWay(a: { train: AITrain; route: Route }, how: 'stop' | 'middle') {
    const lc = this.ctl.of(a.route), t = a.train;
    if (how === 'middle') {
      if (!a.route.middle) return false;
      const lo = t.tailKm - 0.4, hi = t.headKm + 1.5;
      for (const o of this.ctl.occupantsFor(lc)) {
        if (o.id === t.id || o.headKm < lo || o.tailKm > hi) continue;
        for (let km = Math.max(lo, o.tailKm); km <= Math.min(hi, o.headKm); km += 0.05) if (Math.abs(o.offsetAt(km)) < 1) return false;
      }
      const ends = a.route.stations.filter(s => s.type !== 'halt');
      const prev = [...ends].reverse().find(s => s.km <= t.headKm), next = ends.find(s => s.km > t.headKm);
      if (prev && next && !lc.interlocking.claimSection(t.id, prev, next)) return false;
      t.moveToLine(0);
    } else t.holdS = 120;
    lc.interlocking.releaseTrain(t.id);
    lc.dispatcher.manual.add(t.id);
    this.madeWay.set(t, this.time.run + (how === 'stop' ? 120 : 8));
    return true;
  }

  /** The train ahead on the player's own line that a red signal in front of them is for (within 6 km), if any. */
  private signalBlocker() {
    const head = this.dyn.headKm;
    let best: AIEntry | null = null;
    for (const a of this.ai) {
      const t = a.train;
      if (a.route !== this.line || t.gone || this.madeWay.has(t) || t.tailKm < head || t.tailKm - head > 6) continue;
      if (Math.abs(t.offsetAt(t.tailKm) - this.pathOffset(t.tailKm)) > 1) continue;
      if (!best || t.tailKm < best.train.tailKm) best = a;
    }
    return best;
  }

  /** Skip signal: the train ahead goes onto the middle line (or, where there is none free, out of service) so the player can pass. */
  private skipSignal() {
    const a = this.signalBlocker();
    if (!a) { bus.emit('message', { text: 'No train ahead on your line to move: the signal is held for another reason', kind: 'info' }); return; }
    if (this.makeWay(a, 'middle')) { bus.emit('message', { text: `${a.train.def.name} moved onto the middle line: your line is clear`, kind: 'info', ms: 5000 }); return; }
    a.train.gone = true;
    this.ctl.of(a.route).interlocking.releaseTrain(a.train.id);
    bus.emit('message', { text: `${a.train.def.name} taken off the line: your line is clear`, kind: 'info', ms: 5000 });
  }

  /**
   * Free roam across the network: standing at the junction at the far end of the route (the last station of
   * the line driven), a card asks whether to carry on along one of the junction's other routes; the run
   * starts again there on that route (same train, time and weather). "Stay here" leaves it until the train
   * has moved away.
   */
  private spanCard: HTMLDivElement | null = null;
  private spanDismissed = '';
  private updateSpanEnd() {
    const sp = this.overrides.span, L = this.line, last = L.stations[L.stations.length - 1];
    const jd = sp && last?.junction && !this.record && !this.journey ? JUNCTIONS[last.junction.id] : undefined;
    const head = this.dyn.headKm, here = !!jd && head >= last.platformFromKm - 0.05 && head <= last.platformToKm + 0.3;
    if (!here) this.spanDismissed = '';
    const show = here && Math.abs(this.dyn.speed) < 0.3 && this.spanDismissed !== last.code;
    if (show && !this.spanCard) {
      const c = this.spanCard = document.createElement('div');
      c.className = 'span-card';
      const next = jd!.connects.filter(x => x.route !== sp && ROUTES[x.route]);
      c.innerHTML = `<b>${icon('junction')} ${last.name}</b><p>Carry on along another route from here?</p>
        <div class="span-btns">${next.map(x => `<button data-route="${x.route}" data-end="${x.end}">${icon('route')} ${ROUTES[x.route].name}</button>`).join('')}<button data-stay="1">Stay here</button></div>`;
      c.addEventListener('click', e => {
        const b = (e.target as HTMLElement).closest<HTMLElement>('button');
        if (!b) return;
        if (b.dataset.stay) { this.spanDismissed = last.code; return; }
        // the run starts again at this junction on the chosen route, heading along it (away from the junction)
        const o = { ...this.overrides, span: b.dataset.route, route: undefined, startKm: undefined, startStation: jd!.code, track: b.dataset.end === 'start' ? 'DOWN' : 'UP',
          time: formatClock(this.time.seconds % 86400).slice(0, 5), consist: this.spec };
        this.menus.loading(`Carrying on along the ${ROUTES[b.dataset.route!].name}`, 0.5);
        try { sessionStorage.setItem('railbharat.autostart', JSON.stringify({ id: this.scenarioId, overrides: o })); } catch { /* ignore */ }
        location.reload();
      });
      this.ui.appendChild(c);
    }
    if (this.spanCard) this.spanCard.hidden = !show;
  }

  /** The Skip signal button: shown while the player stands at a red signal with a train ahead on their line. */
  private skipSignalBtn: HTMLButtonElement | null = null;
  private skipSignalT = 0;
  private updateSkipSignal(dt: number) {
    if ((this.skipSignalT -= dt) > 0) return;
    this.skipSignalT = 0.5;
    this.updateSpanEnd();
    for (const [t, until] of this.madeWay) {
      if (this.time.run < until && !t.gone) continue;
      for (const l of this.ctl.lines) l.dispatcher.manual.delete(t.id);
      this.madeWay.delete(t);
    }
    const ns = this.nextSignal();
    const show = this.started && !this.record && !this.playerHidden && !this.journey?.driving && Math.abs(this.dyn.speed) < 0.1 && !!ns && ns.aspect === 'R' && ns.km - this.dyn.headKm < 0.6 && !!this.signalBlocker();
    if (show && !this.skipSignalBtn) {
      const b = this.skipSignalBtn = document.createElement('button');
      b.className = 'skip-signal';
      b.textContent = 'Skip signal: move the train ahead onto the middle line';
      b.addEventListener('click', () => this.skipSignal());
      this.ui.appendChild(b);
    }
    if (this.skipSignalBtn) this.skipSignalBtn.hidden = !show;
  }

  /** The station the player's train is at or near (within 1.5 km), and what the train is doing there, for the crowds. */
  private peopleContext() {
    const d = this.dyn, head = d.headKm, ck = this.line.canonicalKm(head);
    let near = null as (typeof this.route.stations)[number] | null, best = 1.5;
    for (const st of this.route.stations) {
      const dd = Math.max(0, Math.abs(st.km - ck) - (st.platformToKm - st.platformFromKm) / 2);
      if (dd < best) { best = dd; near = st; }
    }
    if (!near) return { near: null, player: null };
    const vs = this.line.station(near.code);
    if (!vs) return { near, player: null };
    const onPlatform = head >= vs.platformFromKm && head <= vs.platformToKm + 0.05;
    const offset = this.path.offsetAt(head);
    const line = vs.lineInfo.find(l => Math.abs(l.offset - offset) < 0.5)?.id ?? this.line.running.id;
    // doors of passenger coaches (both ends of each), surveyed km
    const doors: Door[] = [];
    if (onPlatform) for (const v of this.consist.vehicles) {
      const c = COACHES[v.typeId];
      if (v.kind !== 'coach' || !c || (c.kind && c.kind !== 'coach')) continue;
      for (const o of [1.4, v.length - 1.4]) doors.push({ km: this.line.canonicalKm(head - (v.frontOffset + o) / 1000), x: 0, z: 0 });
    }
    return {
      near,
      player: { code: near.code, stopped: onPlatform && Math.abs(d.speed) < 0.1 && this.stop.work.doorsOpen, approaching: head > vs.platformFromKm - 0.8 && head < vs.platformToKm && Math.abs(d.speed) > 1, doors, platformLines: [line] },
    };
  }

  /**
   * Compile the shadow pass's depth shaders now, behind the loading screen:
   * compileAsync does not cover shadows, and each caster type's depth shader
   * compiling on its first shadow render stalled the drive for ~0.7 s. One
   * render with the shadow camera opened over everything loaded does it.
   */
  private warmShadows() {
    const sun = this.lighting.sun;
    if (!sun.castShadow) return;
    const cam = sun.shadow.camera as THREE.OrthographicCamera;
    const saved = [cam.left, cam.right, cam.top, cam.bottom, cam.far] as const;
    const pos = sun.position.clone(), tgt = sun.target.position.clone();
    const c = this.cameras.camera.position;
    sun.target.position.set(c.x, c.y, c.z);
    sun.position.set(c.x + 300, c.y + 3000, c.z + 300);
    sun.target.updateMatrixWorld();
    cam.left = cam.bottom = -3000; cam.right = cam.top = 3000; cam.far = 8000;
    cam.updateProjectionMatrix();
    this.syncRenderCamera();
    this.rs.renderer.render(this.scene, this.rcam);
    [cam.left, cam.right, cam.top, cam.bottom, cam.far] = saved;
    cam.updateProjectionMatrix();
    sun.position.copy(pos); sun.target.position.copy(tgt); sun.target.updateMatrixWorld();
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
    // rail traffic changed in Settings (running game): the AI traffic starts over at the new level
    if (this.trafficSetting >= 0 && s.traffic !== this.trafficSetting) this.restartTraffic();
    this.rs.setBloom(s.bloom);
    this.lighting.applyQuality(p);
    wind.setGrassFade(p.grassRadius);
    this.rs.setMaxPixelRatio(this.rec.output ? 1 : s.maxPixelRatio);
    this.rs.setRenderScale(this.renderScale());
    this.appliedScale = this.renderScale();
    this.adaptiveRes.scale = this.appliedScale;
    this.cameras.camera.far = p.drawDistance + 400;
    this.audio?.setVolumes(s.volumes);
    if (!this.scenario.rules) this.time.scale = this.bench ? 0 : s.dayNightSpeed;
  }

  /** render scale in force: a fixed Record Mode output size renders at exactly its pixels */
  private renderScale() { return this.rec.output ? 1 : this.rec.renderScale ?? settings.get().renderScale; }

  private pausedNeedsRender = false;
  private onResize = () => {
    syncViewport();
    this.pausedNeedsRender = true;
    const w = this.rec.output?.w ?? innerWidth, h = this.rec.output?.h ?? innerHeight;
    // a fixed output size (Record Mode, its captures): exactly its pixels, whatever the screen and adaptive resolution do
    if (this.rs.exactPixels !== !!this.rec.output) { this.rs.exactPixels = !!this.rec.output; this.appliedScale = this.renderScale(); this.rs.setRenderScale(this.appliedScale); }
    this.rs.resize(w, h);
    this.cameras.camera.aspect = w / h;
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
      case 'doors': this.stop.toggle(); break;
      case 'vcb': s.toggleVcb(); break;
      case 'fuelPump': s.toggleFuelPump(); break;
      case 'engine': s.toggleEngine(); break;
      case 'cabLight': s.toggleCabLight(); break;
      case 'markers': s.toggleMarkers(); break;
      case 'flasher': s.toggleFlasher(); break;
      case 'routeAhead': this.openRouteAhead(); break;
      case 'throwPoints': this.throwNextPoints(); break;
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
    this.keyboard.enabled = this.kbDriving;
    this.mouse.enabled = true;
    if (!this.record) this.audio?.fadeIn(settings.get().volumes.master);
    else this.record.resumed();
  }

  private showPauseMenu() {
    this.menus.pause({
      title: `${this.scenario.name} · ${this.route.data.name}`,
      godActive: this.god.active,
      resume: () => this.resume(),
      tutorial: () => this.startTutorial(),
      godMode: () => this.openGodMode(),
      record: this.record ? () => this.record?.askExit() : undefined,
      plan: this.journey ? () => this.menus.editJourney(this.journey!.j, this.journey!.ahead(), stops => { this.journey!.setStops(stops); this.showPauseMenu(); }, () => this.showPauseMenu()) : undefined,
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
    try { sessionStorage.setItem('railbharat.autostart', JSON.stringify({ id: this.scenarioId, overrides: this.overrides, record: !!this.record })); } catch { /* ignore */ }
    location.reload();
  }
  overrides: ScenarioOverrides = {};
  static quit() { try { sessionStorage.removeItem('railbharat.autostart'); } catch { /* ignore */ } location.reload(); }

  private controlAt(x: number, y: number): string | null {
    if (!this.cameras.mode.inCab) return null;
    this.raycaster.setFromCamera(new THREE.Vector2(x, y), this.rcam);
    // a model's own cab: only a console with hit boxes is clickable (otherwise keyboard / gamepad / touch drive it)
    if (this.journey?.driving) {
      const hit = this.raycaster.intersectObjects(this.journey.shunterRig()?.hitTargets ?? [], false)[0];
      return hit && hit.distance < 2.5 ? (hit.object.userData.control as string) : null;
    }
    const rig = this.trainView.loco.rig;
    const targets = !this.trainView.loco.usesModelCab ? this.controls.hitTargets : rig ? rig.hitTargets : this.panel?.ready ? this.panel.hitTargets : [];
    const hit = this.raycaster.intersectObjects(targets, false)[0];
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
    const e = this.god.eff;
    let v = Math.min(e.ignoreLineSpeed ? Infinity : this.line.speedLimitAt(km), e.unlimitedSpeed ? Infinity : this.consist.loco.maxSpeedKmph);
    if (e.ignoreLineSpeed) return v; // God Mode test: line, loop and calling-on limits lifted
    if (!this.line.lineSpeedAt(this.pathOffset(km))) v = Math.min(v, 30); // loop lines, turnouts, wrong line (the middle line is full speed)
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
    s.vigilanceEnabled = e.vigilance && !this.record && (settings.get().driving !== 'beginner' || this.tutorialPractice || !!this.tutorial); s.ignoreMaxSpeed = e.unlimitedSpeed;
    for (const l of this.ctl.lines) l.block.forceGreen = this.rec.forceGreen || (l === this.lc && e.forceGreen);
    // (God Mode time speed fast-forwards the whole world, the train covering ground with it: see engine.speed)
    this.time.scale = this.rec.timeScale ?? (this.god.active && e.freezeTime ? 0 : this.baseTimeScale);
    const pd = this.rec.playerDrive;
    if (pd) {
      // Record Mode: the player's train driven to its train settings
      this.autoDriver.drive(dt, d, s, {
        limitKmph: Math.min(pd.kmph, pd.obeyLimits ? limit : Infinity, this.consist.loco.maxSpeedKmph),
        decel: { gentle: 0.35, normal: 0.55, aggressive: 0.85 }[pd.style],
        nextStop: pd.obeySignals ? this.block.nextSignal(d.headKm, this.path.offsetAt(d.headKm), true, this.pathOffset) : null,
        stationStopKm: null, hold: this.stop.holding, endKm: this.line.lengthKm - 0.04,
      });
    } else if (e.autoDrive || e.autoStopAtRed) {
      // auto-drive follows God Mode's rules: line limits off when they are not enforced, the train's real
      // braking with instant brakes, reds ignored when signals are not obeyed
      const free = !e.speedEnforcement || e.ignoreLineSpeed;
      const brake = this.consist.vehicles.reduce((a, v) => a + v.maxBrakeN, 0) / (this.consist.mass * d.massScale);
      const targets = {
        limitKmph: free ? (e.unlimitedSpeed ? Infinity : this.consist.loco.maxSpeedKmph) : limit,
        decel: e.instantBrakes ? Math.max(0.45, brake * 0.8) : undefined,
        nextStop: e.obeySignals ? this.block.nextSignal(d.headKm, this.path.offsetAt(d.headKm), true, this.pathOffset) : null,
        stationStopKm: this.nextBookedStopKm(),
        // (also while a Route Mode journey's shunting, coupling or loco change here is not done, or the player drives the shunter)
        hold: this.stop.holding || !!this.journey?.driving || !!this.journey?.holdsHere(),
        endKm: this.line.lengthKm - 0.04,
      };
      // (auto-drive is the driver: it answers the vigilance alarm, and resets a penalty once stopped)
      if (e.autoDrive && s.vigilanceState !== 'ok') s.acknowledgeVigilance(d.speed);
      if (e.autoDrive) this.autoDriver.drive(dt, d, s, targets);
      else this.autoDriver.autoStop(d, s, targets);
    }
    s.update(dt, d.speed, limit, true);
    d.baseAdhesion = this.weather.adhesion(this.consist.loco.adhesion) * (1 + Math.sin(this.t * 0.37) * 0.04);
    const prevHead = d.headKm;
    if (this.bench) { d.speed = this.bench.cfg.speedKmph / 3.6; s.vigilanceTimer = 0; }
    // doors open: no traction (interlock)
    const doorsOpen = this.stop.blocksTraction;
    if (doorsOpen && s.notch > 0 && this.t - this.doorHintAt > 4) { this.doorHintAt = this.t; bus.emit('message', { text: isTouch ? 'Close doors first' : `Close doors first (${settings.get().keys.doors.replace(/^Key/, '')})`, kind: 'warn', ms: 3000 }); }
    const away = !!this.ownSys; // (in the shunter: the controls are its, the train stands)
    d.step(dt, { notch: away ? 0 : s.notch, regenNotch: away ? 0 : s.regen, reverser: away ? 0 : s.reverser, sander: s.sander, powerAvailable: s.powerAvailable && !doorsOpen && !away }, env);
    if (this.bench) d.speed = this.bench.cfg.speedKmph / 3.6;
    // God Mode instant brakes: the train stops at once (up to 12 m/s², as hard as the brake asked: the train
    // brake's service range, emergency, or the loco brake)
    if (e.instantBrakes) {
      const b = d.brakes, svc = BRAKE_POSITIONS.indexOf('Service 1');
      const ask = b.emergency ? 1 : Math.max(b.handle >= svc ? (b.handle - svc + 1) / (BRAKE_POSITIONS.length - svc) : 0, b.independent);
      if (ask > 0 && d.speed !== 0) { const dv = 12 * ask * dt; d.speed = Math.abs(d.speed) <= dv ? 0 : d.speed - Math.sign(d.speed) * dv; }
    }
    this.journey?.afterStep();
    this.bufferStops();
    for (const id of this.path.update(d.headKm, d.tailKm)) bus.emit('switch-crossed', { id });
    // scenario AI trains (traffic trains are moved by their manager)
    const managed = (t: AITrain) => !!this.oncoming?.trains.includes(t) || !!this.sameLine?.trains.includes(t) || this.junctionTraffic.some(x => x.jt.trains.includes(t));
    for (const a of this.ai) if (!a.train.gone && !managed(a.train)) a.train.update(dt);
    for (const a of [...this.ai]) if (a.train.gone && !managed(a.train)) { this.ctl.of(a.route).remove(a.train); this.removeAI(a.train); }
    if (this.oncoming && !this.bench) this.oncoming.update(dt, this.oncoming.route.viewKm(this.line.canonicalKm(d.headKm)));
    if (this.sameLine) this.sameLine.update(dt, d.headKm);
    // junction traffic: new trains only while the camera is within 8 km (those running go on)
    const cam = this.cameras.camera.position;
    for (const { jt, centre } of this.junctionTraffic) jt.update(dt, this.time.run, cam.distanceTo(centre) < 8000, this.playerHidden ? undefined : { view: this.line, headKm: d.headKm });
    this.recordRunner?.sim(dt);

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
      this.ctl.update(this.sigAcc, this.time.run);
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
    const tg = this.rec.cameraTarget?.() ?? this.journey?.cameraTarget();
    if (tg) {
      return {
        dt, time: this.t, train: tg.view, route: tg.route, field: this.field, headKm: tg.headKm, speed: tg.speed,
        lateralAccel: tg.speed * tg.speed * tg.route.alignment.curvatureAt(tg.headKm), slack: 0, jolt: 0, shake: 0,
        eye: tg.eye, keys: c => this.keyboard.isDown(c), freeRange: Infinity,
      };
    }
    const v = this.dyn.speed;
    return {
      dt, time: this.t, train: this.trainView, route: this.line, field: this.field, headKm: this.dyn.headKm, speed: v,
      lateralAccel: v * v * this.line.alignment.curvatureAt(this.dyn.headKm), slack: this.dyn.slack, jolt: this.jolt, shake: this.shake,
      eye: this.cabEye(), keys: c => this.keyboard.isDown(c),
      freeRange: this.god.eff.unlockFreeCamera || this.record ? Infinity : 4000,
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
    // Record Mode: frozen (0) or slow / fast motion; the world's own motion (rain, smoke, wind, people, water) follows
    // God Mode time speed: everything runs that many times faster (trains, signals, the clock)
    const fast = this.god.active && !this.god.eff.freezeTime ? this.god.eff.timeSpeed : 1;
    this.engine.speed = this.warp * this.rec.scale * fast;
    const wdt = dt * this.rec.scale;
    TrainView.clock = this.t;
    TrainView.eye.copy(this.cameras.camera.position);

    // trains
    this.trainView.update(this.line, d.headKm, km => this.path.offsetAt(km), d.odometer, night);
    // every loco section: pantographs follow the switch; lights on the leading cab, red tail markers on
    // the rear cab of a light engine (the last vehicle is a loco section facing backwards)
    const tv = this.trainView, vs = this.consist.vehicles, last = vs[vs.length - 1], lm = tv.loco;
    tv.locos.forEach((lm, k) => {
      lm.setPantograph(s.pantoPos, this.line.contactHeightAt(d.headKm));
      if (k === 0) lm.setLights(s.headlight, s.markers, s.flasher, this.t, s.reverser);
      else lm.setLights(0, s.markers && k === tv.locos.length - 1 && last.kind === 'loco' && !!last.reversed, false, this.t, -s.reverser);
    });
    for (const a of this.ai) {
      if (a.train.gone) continue;
      a.view.update(a.route, a.train.headKm, km => a.train.offsetAt(km), a.train.headKm * 1000, night);
      a.view.loco.setPantograph(1, a.route.contactHeightAt(a.train.headKm));
      a.view.loco.setLights(night > 0.3 || this.weather.p.fog > 0.004 ? 2 : 1, true, false, this.t, 1);
    }
    this.updateYardMoves(wdt, night, this.cameras.camera.position);
    this.journey?.update(dt * this.engine.speed, night);
    this.updateSkipSignal(dt);
    if (!this.playerHidden) { this.updatePassing(wdt); this.updateSmoke(wdt); }
    this.recordRunner?.frame(dt, wdt);

    // camera
    const ctx = this.cameraContext(dt);
    this.cameras.update(ctx);
    this.recordRunner?.afterCamera?.(dt);
    this.syncRenderCamera();
    const cam = this.cameras.camera;
    // (Shunt myself: the camera is in the shunter's cab, not ours)
    const away = !!this.journey?.driving;
    const inCab = !!this.cameras.mode.inCab && !away;
    this.cab.group.visible = inCab;
    if (this.modelInterior) this.modelInterior.group.visible = inCab && this.trainView.loco.usesModelCab;
    if (this.panel) {
      this.panel.group.visible = inCab && this.panel.ready;
      if (!inCab && this.started) this.wantCab &&= this.cameras.index === 4; // another view picked: forget the cab request
      // phones: the console's memory back after 2 minutes out of the cab (reloaded on the way in)
      if (!inCab && isTouch && (this.panel.idle += dt) > 120) this.panel.drop();
    }
    // a loco model with its own cab: ours is not drawn (only its cab lamp stays)
    const modelCab = this.trainView.loco.usesModelCab;
    if (modelCab !== this.modelCabShown) {
      this.modelCabShown = modelCab;
      this.cab.group.traverse(o => { if ((o as THREE.Mesh).isMesh) o.visible = !modelCab; });
      this.lastInCab = !inCab; // re-apply the cab view hiding below
    }
    if (inCab !== this.lastInCab) {
      // from the driver's seat the undercarriage, pantographs and outer glass are never visible: skip their draws
      this.lastInCab = inCab;
      lm.setCabView(inCab);
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
    // deep in a tunnel the hillside's forest above and around is still in view (no occlusion culling):
    // trees and buildings are not drawn until the portal the camera faces is near
    const portal = tunnelKm ? this.portalAhead() : null;
    this.chunks.setPropsVisible(portal === null || portal < 150);
    this.lighting.tunnel += ((tunnelKm ? 1 : 0) - this.lighting.tunnel) * Math.min(1, dt * 1.5);
    const speedVec = new THREE.Vector3(Math.cos(this.headHeading()) * d.speed, 0, Math.sin(this.headHeading()) * d.speed);
    // shelter: no rain inside tunnels; none under platform roofs near the camera (cab glass and roof drumming too)
    const roofs: RoofCover[] = [];
    for (const sv of this.stations.values()) for (const r of sv.roofs) if (Math.hypot(r.x - cam.position.x, r.z - cam.position.z) < r.halfLen + 60) roofs.push(r);
    const covered = roofs.length ? (x: number, y: number, z: number) => underRoof(roofs, x, y, z) : undefined;
    this.sheltered = !!tunnelKm || !!covered?.(cam.position.x, cam.position.y, cam.position.z);
    this.weather.update(wdt, cam.position, inCab ? speedVec : new THREE.Vector3(), inCab ? 3.2 : 0, !!tunnelKm, covered);
    wind.update(wdt, this.weather.p.wind);
    this.sky.group.scale.setScalar((cam.far * 0.85) / 2000);
    // the region around the camera: its air (haze, tint, clouds) and its far horizon
    const regions = this.route.regionWeights(this.cameraKm());
    const air = this.air;
    air.haze = 0; air.clouds = 0; air.tintW = 0; air.tint.setRGB(0, 0, 0);
    for (const { r, w } of regions) {
      air.haze += (r.air?.haze ?? 1) * w; air.clouds += (r.air?.clouds ?? 0) * w;
      if (r.air?.tint) { air.tint.add(this.tmpColor.set(r.air.tint).multiplyScalar(w)); air.tintW += w; }
    }
    if (air.tintW > 0) air.tint.multiplyScalar(1 / air.tintW);
    this.sky.update(wdt, this.rcam.position, this.time, this.weather, air.clouds);
    const lampSpots: THREE.Vector3[] = [];
    for (const st of this.stations.values()) lampSpots.push(...st.lampSpots);
    this.lighting.update(inCab ? cam.position : this.trainView.group.position, this.time, this.weather, this.sky, settings.get().fogMultiplier, lampSpots, cam.position, { haze: air.haze, tint: air.tintW > 0 ? air.tint : null });
    // the ring stands on the valley floor (the line's level), not on whatever hill the camera is on
    this.horizon.update(dt, this.rcam.position, this.route.alignment.elevationAt(this.cameraKm()) - this.origin.y, effective().drawDistance + 200,
      Horizon.blend(regions.map(x => ({ ...x, biome: biomeOf(x.r) }))), this.lighting.fog.color, this.time.day);
    this.lighting.fog.density = Math.max(this.lighting.fog.density, 1.35 / effective().drawDistance);
    // bloom only where it shows (lamps at night, glow in fog, tunnel mouths): in daylight it costs a full-screen
    // blur chain for almost nothing
    const glow = night > 0.12 || this.weather.p.fog > 0.004 || this.lighting.tunnel > 0.05;
    this.rs.setBloom(settings.get().bloom && glow, (0.25 + night * 0.35 + Math.min(0.4, this.weather.p.fog * 20)) * this.rec.glow);
    this.rs.renderer.toneMappingExposure = 1.0 + night * 0.35;
    const headlightOn = s.headlight > 0;
    lm.setBeam(headlightOn ? Math.min(0.12, (night * 0.06 + this.weather.p.fog * 3)) * (s.headlight === 2 ? 1 : 0.5) * this.rec.beam : 0);

    // cab
    const shRig = away && this.cameras.mode.inCab ? this.journey!.shunterRig() : null;
    if (shRig) { const b = this.drivenBrakes; shRig.update(dt, { ...this.rigValues(), speed: this.journey!.shunterKmph(), trainBrake: b.handle / (BRAKE_POSITIONS.length - 1), locoBrake: b.independent, bp: 5, bc: b.independent * 3.5, mr: 9 }); }
    if (inCab) {
      this.cab.update(wdt, this.sheltered ? 0 : this.weather.p.rain, d.speed, s.wipers);
      this.cab.setCabLight(s.cabLight);
      const ns = this.nextSignal();
      const units = settings.get().units;
      const conv = units === 'mph' ? 0.6214 : 1;
      const readings = {
        speedKmph: Math.abs(d.speedKmph), limit: Math.round(this.currentLimit() * conv), bp: d.brakes.locoBP, bc: d.brakes.locoBC, mr: d.brakes.mr, er: d.brakes.er,
        kV: s.lineVoltage, amps: d.traction.motorCurrent, teKN: Math.abs(d.traction.tractiveForce) / 1000,
        slip: d.traction.slipping, overspeed: s.overspeed, vigilance: s.vigilanceState, brakeApplied: d.brakes.locoBC > 0.3,
        pantoDown: s.pantoDown, vcbOpen: !s.vcb, km: this.line.canonicalKm(d.headKm), nextSignal: ns ? ns.id : '-', signalDist: ns ? (ns.km - d.headKm) * 1000 : 99999,
        aspect: ns ? ns.aspect : '-', clock: formatClock(this.time.seconds, true), units: units === 'mph' ? 'mph' : 'km/h', displaySpeed: Math.abs(d.speedKmph) * conv,
      };
      const rig = this.trainView.loco.rig;
      // the model's own levers, needles and screens (data model.cab.rig)
      if (rig) rig.update(dt, this.rigValues());
      else if (this.modelInterior?.group.visible) this.modelInterior.update(dt, readings, night);
      else if (this.panel) {
        const L = this.line, head = d.headKm, st = L.stations.find(x => x.platformToKm > head + 0.01);
        const stDist = st ? ((this.plan.get(st.code) ? L.stopKm(st, this.consist.length) : st.platformFromKm) - head) * 1000 : 0;
        this.panel.update(dt, readings, { station: st?.name ?? '', stationDist: stDist });
      }
      else this.controls.update(dt, readings, night);
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
        this.addCompiled(v.group, () => true, !this.started); // built 3 km ahead: shaders compile in the background
      }
      const dist = v.position.distanceTo(cam.position);
      v.group.visible = dist < drawD && !this.rec.hideSignals;
      if (v.group.visible) v.update(cam.position, night, this.lighting.fog.density, blink);
    }
    for (const sv of this.switchViews) sv.update();
    for (const st of this.stations.values()) st.update(this.time.seconds, this.t, st.centre.distanceTo(cam.position) < 600);
    if (this.t - this.boardsAt > 4) { this.boardsAt = this.t; this.updateDepartureBoards(); }
    this.traffic.update(wdt, cam.position);
    this.billboards.update(wdt, this.lighting.nightLight);
    this.stop.update(wdt);
    if (this.people) { const pc = this.peopleContext(); this.people.update(wdt, cam.position, pc.near, pc.player); }
    this.waterfalls.update(wdt, this.weather.p.rain > 0.3 || this.route.regionAt(this.cameraKm()).sideSlope > 0);

    prof.end('scenery');
    // station announcements: from about 1.2 km before the platform until the train is 1 km past it (not at halts,
    // not in Record Mode's studio, where there is no train of yours)
    if (this.announcer) {
      const st = this.playerHidden ? undefined : this.line.stations.find(x => x.type !== 'halt' && d.headKm > x.platformFromKm - 1.2 && d.tailKm < x.platformToKm + 1.0);
      let at: { code: string; x: number; y: number; z: number } | null = null;
      if (st) {
        const sv = this.stations.get(st.code);
        if (sv) at = { code: st.code, x: sv.centre.x, y: sv.centre.y + 6, z: sv.centre.z };
        else { const f = newFrame(); this.route.alignment.sampleOffset(this.line.canonicalKm(st.km) * 1000, st.buildingSide * 20, f); at = { code: st.code, x: f.x, y: f.y + 6, z: f.z }; }
      }
      this.announcer.update(wdt, at);
    }

    // audio
    this.updateAudio(wdt);

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
    this.pantoInd?.update(this.sys.pantoPos, this.sys.pantoUp, performance.now()); // every frame: smooth travel
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
    // dynamic resolution, from the last frame's time (not in benchmarks: they measure a fixed setup).
    // Changed before rendering: resizing clears the canvas, so a change after it showed a blank frame.
    const st = settings.get();
    if (st.adaptiveQuality && !this.bench && !this.rec.noAdaptive && !this.rec.output) {
      const sc = this.adaptiveRes.update(this.engine.rawMs, this.rs.gpuMs, st.renderScale, dt);
      if (Math.abs(sc - this.appliedScale) > 1e-3) { this.appliedScale = sc; this.rs.setRenderScale(sc); }
    } else if (Math.abs(this.renderScale() - this.appliedScale) > 1e-3) { this.appliedScale = this.renderScale(); this.rs.setRenderScale(this.appliedScale); }
    prof.begin('render');
    this.rs.render();
    prof.end('render');
    this.recordRunner?.afterRender?.();
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

  /** God Mode scenery preview (Free Roam): the region the whole route is shown as, or null */
  private sceneryPreview: string | null = null;
  private ownRegions: RouteData['regions'] | null = null;

  /**
   * Show the whole route as one landscape (God Mode, Free Roam): the route's
   * regions are replaced, the height field rebuilt and every terrain tile
   * rebuilt by the workers (the old tiles stay until their new ones are ready).
   */
  private setSceneryPreview(id: string | null) {
    if (id === this.sceneryPreview || this.scenario.rules) return;
    this.ownRegions ??= this.route.data.regions;
    this.route.data.regions = id ? [{ fromKm: -1, toKm: this.route.lengthKm + 1, region: id }] : this.ownRegions;
    this.sceneryPreview = id;
    this.field.refresh();
    this.chunks.reinit(this.route);
    this.pausedNeedsRender = true;
    bus.emit('message', { text: id ? `Scenery preview: ${REGIONS[id]?.name ?? id}` : "Scenery: the route's own", kind: 'info', ms: 3000 });
  }

  /** Free Roam stations made stops for auto-drive (God Mode "Must stop at stations"), with what the plan had before. */
  private autoStops = new Map<string, boolean | null>();

  /**
   * Which stops the player's train must make, from God Mode:
   *  - "Must stop at stations" off: booked stops are not required (the starter is not held for them)
   *  - Free Roam has no timetable: with auto-drive and "Must stop" on, every station on the line
   *    becomes a stop, so the auto-driver stops, boards and departs like at a booked stop
   * Auto-drive itself never skips a required stop: it boards, waits or skips the wait, then departs.
   */
  private syncStops() {
    const g = this.god, e = g.eff;
    if (this.tutorialPractice || (g.active && !e.mustStop)) this.dispatcher.departNow.add('player');
    else this.dispatcher.departNow.delete('player');
    const want = !this.scenario.timetable.length && g.active && e.autoDrive && e.mustStop;
    for (const st of this.line.stations) {
      const had = this.autoStops.has(st.code);
      // only stations still ahead: the one the train stands at (or has passed) is not made a stop it can never arrive at
      if (want && !had && st.platformFromKm > this.dyn.headKm) {
        const p = this.plan.get(st.code);
        this.autoStops.set(st.code, p ? p.stop : null);
        if (p) p.stop = true; else this.plan.set(st.code, { station: st.code, line: '', stop: true });
      } else if (!want && had) {
        const prev = this.autoStops.get(st.code)!;
        const p = this.plan.get(st.code);
        if (prev === null) this.plan.delete(st.code); else if (p) p.stop = prev;
        this.autoStops.delete(st.code);
      }
    }
  }

  /** Head km of the next booked stop marker ahead that has not been served yet (null if none). */
  private nextBookedStopKm() {
    // (a Route Mode journey: its stops are always kept)
    if (!this.god.eff.mustStop && !this.journey) return null;
    for (const st of this.line.stations) {
      if (st.platformToKm < this.dyn.headKm) continue;
      const p = this.plan.get(st.code);
      if (!p?.stop || this.dispatcher.stationState('player', st.code)?.arrived) continue;
      // a journey ending in a junction's bay: up to the buffer stop
      return this.stopTargetKm(st);
    }
    return null;
  }

  /** Where the head stops at a station: its stop mark, or a journey's end bay just short of the buffer stop. */
  private stopTargetKm(st: StationInfo) {
    return this.endBay?.code === st.code ? this.endBay.km : this.line.stopKm(st, this.consist.length);
  }

  /** dead ends (buffer stops) of each direction's view, found once */
  private deadEndsOf = new WeakMap<Route, DeadEnd[]>();
  /**
   * Buffer stops are solid: the train's leading end (or its tail, setting back) stops dead at the headstock,
   * on the line that ends there; faster than walking pace it is a hard knock.
   */
  private bufferStops() {
    const d = this.dyn, v = this.line;
    let ends = this.deadEndsOf.get(v);
    if (!ends) this.deadEndsOf.set(v, (ends = deadEnds(v.graph.lines, v.graph.switches, v.lengthKm)));
    // the headstock stands 3.1 m short of the line's end (TrackMeshBuilder's buffer stop)
    const FACE = 0.0031;
    for (const e of ends) {
      const fwd = e.dir > 0, endKm = fwd ? d.headKm : d.tailKm, face = e.km - e.dir * FACE;
      if (Math.abs(this.path.offsetAt(endKm) - e.offset) > 0.5) continue;
      const past = fwd ? endKm > face && endKm < e.km + 0.05 : endKm < face && endKm > e.km - 0.05;
      if (!past || (fwd ? d.speed <= 0 : d.speed >= 0)) continue;
      const kmph = Math.abs(d.speed) * 3.6;
      d.headKm = fwd ? face : face + this.consist.length / 1000;
      d.speed = 0;
      if (kmph > 2) bus.emit('coupler-jolt', { magnitude: Math.min(1, kmph / 15) });
      if (kmph > 5) bus.emit('message', { text: `Hit the buffer stop at ${Math.round(kmph)} km/h!`, kind: 'penalty', ms: 5000 });
    }
  }

  /** Inside a tunnel: metres to the portal the camera faces (null outside one). */
  private portalAhead() {
    const c = this.cameras.camera, n = this.field.nearest(c.position.x, c.position.z, 12);
    const t = n && this.route.tunnels.find(x => n.km >= x.fromKm && n.km <= x.toKm);
    if (!n || !t) return null;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(c.quaternion);
    const toward = fwd.x * Math.cos(n.heading) + fwd.z * Math.sin(n.heading) >= 0 ? t.toKm : t.fromKm;
    return Math.abs(toward - n.km) * 1000;
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

  /**
   * Add a newly built object to the world once its shaders are compiled. A
   * shader compiled on first draw stalls the frame (about a second per program
   * on ANGLE / Direct3D); compileAsync lets the driver compile in parallel
   * (KHR_parallel_shader_compile) while we keep rendering. Objects are built a
   * ring ahead of the draw distance, so the short wait is never seen.
   * `now`: add at once (initial load, teleport: the loading screen covers it).
   */
  private addCompiled(o: THREE.Object3D, stillWanted: () => boolean, now: boolean) {
    if (now) { this.world.add(o); return; }
    const add = () => { if (stillWanted() && !o.parent) this.world.add(o); };
    this.rs.renderer.compileAsync(o, this.rcam, this.scene).then(add, add);
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
        this.addCompiled(g, () => this.trackChunks.get(i) === g, all);
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
      if (dd < p.drawDistance && !it.obj && (all || built < 4)) { built++; const o = (it.obj = it.build()); this.addCompiled(o, () => it.obj === o, all); }
      else if (dd > p.drawDistance + 600 && it.obj) it.dispose!();
    }
  }

  private updateAudio(dt: number) {
    if (!this.audio || !this.trainAudio) return;
    const cam = this.cameras.camera;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const lp = this.rec.listener?.() ?? cam.position;
    this.audio.setListener(lp.x, lp.y, lp.z, fwd.x, fwd.y, fwd.z);
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
    const quiet = this.playerHidden; // no train of yours in the studio: nothing of it is heard
    this.trainAudio.update({
      speedKmph: quiet ? 0 : d.speedKmph, amps: quiet ? 0 : d.traction.motorCurrent, vcb: !quiet && (this.sys.isDiesel ? this.sys.engine === 'running' : this.sys.vcb), compressor: !quiet && d.brakes.compressorOn,
      engine: this.sys.isDiesel && !quiet ? { rpm: this.sys.engineRpm, load: (d.traction as DieselTraction).load, cranking: this.sys.engine === 'cranking' } : undefined,
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
    // the nearest waterfall on show
    let fall: { x: number; y: number; z: number; d: number } | null = null;
    if (this.waterfalls.group.visible) for (const p of this.waterfalls.positions) {
      const dd = p.distanceTo(cam.position);
      if (!fall || dd < fall.d) fall = { x: p.x, y: p.y, z: p.z, d: dd };
    }
    let station: { x: number; y: number; z: number; d: number } | null = null;
    for (const sv of this.stations.values()) {
      const dd = sv.centre.distanceTo(cam.position);
      if (!station || dd < station.d) station = { x: sv.centre.x, y: sv.centre.y, z: sv.centre.z, d: dd };
    }
    this.ambience!.update(dt, {
      rain: this.sheltered ? this.weather.p.rain * 0.25 : this.weather.p.rain, wind: this.weather.p.wind, day: this.time.day, speed: d.speed, inCab: !!this.cameras.mode.inCab,
      river, fall, station, cam: cam.position,
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
    const stDist = st ? ((stopping ? this.stopTargetKm(st) : st.platformFromKm) - head) * 1000 : 0;
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
      station: st ? { name: `${st.name}${this.stop.summary ? ' · ' + this.stop.summary : ''}`, dist: stDist } : null,
      timetable: { clock: formatClock(this.time.seconds, true), arrival, departure, nextStop: st ? st.name : null },
      score: this.scenario.rules && this.scoring.enabled ? this.scoring.total : null,
    });
    this.vigPopup.update(s.vigilanceState, s.vigilanceLeft);
    this.announceRoute();
    this.hud.update({
      speed: Math.abs(d.speedKmph) * conv, units: units === 'mph' ? 'mph' : 'km/h', limit: Math.round(limit * conv),
      notch: s.notch > 0 ? `P${s.notch}` : s.regen > 0 ? `B${s.regen}` : '0', reverser: s.reverser > 0 ? 'F' : s.reverser < 0 ? 'R' : 'N',
      bp: d.brakes.locoBP, bc: d.brakes.lastBC, mr: d.brakes.mr,
      signal: ns ? { id: ns.id, aspect: ns.aspect, dist: (ns.km - head) * 1000 } : null,
      station: st ? { name: `${st.name}${this.stop.summary ? ' · ' + this.stop.summary : ''}`, dist: stDist, stop: stopping } : null,
      restriction, clock: formatClock(this.time.seconds, true), eta, due,
      gradient: formatGradient(L.alignment.gradientAt(head)), km: L.canonicalKm(head),
      score: this.scenario.rules ? this.scoring.total : null,
      camera: CAMERA_NAMES[this.cameras.index], weather: WEATHER[this.weather.id].name,
    });
  }

  private onEnd(success: boolean, reason: string) {
    if (this.ended || this.record) return;
    this.ended = true;
    if (this.scenario.rules && this.scoring.enabled) recordScore(this.scenarioId, this.scoring.total, this.scoring.grade);
    setTimeout(() => {
      this.engine.paused = true;
      this.keyboard.enabled = false;
      this.menus.report({
        success, reason, total: this.scoring.total, grade: this.scoring.grade, totals: this.scoring.totals, entries: this.scoring.entries,
        name: this.scenario.name, distanceKm: this.dyn.odometer / 1000, durationS: this.time.run - this.startClock,
      }, { restart: () => this.restart(), quit: () => Game.quit() });
    }, success ? 2500 : 1500);
  }

  // ------------------------------------------------------------------ Record Mode
  /** Open Record Mode (pause menu, desktop): its code loads now, the first time. */
  private async enterRecord() {
    if (isTouch || this.record || this.ended) return;
    this.menus.loading('Opening Record Mode', 0.6);
    const { RecordMode } = await import('./record/RecordMode');
    this.recordUsed = true;
    this.scoring.enabled = false;
    // trains kept from an earlier session come back under the studio's control
    const kept = this.recordRunner;
    this.record = new RecordMode(this.recordHost(), this.menus, kept);
    this.recordRunner = this.record;
    this.resume();
  }

  /** What Record Mode may read and change. */
  private recordHost(): RecordHost {
    const g = this;
    return {
      scene: this.scene, world: this.world, origin: this.origin, rcam: this.rcam, cameras: this.cameras, canvas: this.rs.renderer.domElement, rs: this.rs,
      field: this.field, railway: this.railway, route: this.route, ctl: this.ctl, time: this.time, weather: this.weather, lighting: this.lighting,
      audio: this.audio, trainAudio: () => this.trainAudio, rec: this.rec, scenarioId: this.scenarioId,
      keys: c => this.keyboard.isDown(c),
      cameraContext: dt => this.cameraContext(dt),
      addCamera: m => this.cameras.register(m),
      player: {
        view: this.trainView, consist: this.consist, sys: this.sys,
        route: () => g.line, headKm: () => g.dyn.headKm, speed: () => g.dyn.speed, offsetAt: km => g.path.offsetAt(km),
        setSpeedNow: kmph => {
          g.dyn.speed = kmph / 3.6;
          // brakes off at once (the auto-driver holds the speed from here)
          const b = g.dyn.brakes; b.handle = 1; b.er = 5; b.bp.fill(5); b.bc.fill(0);
        },
        toggleDoors: () => g.stop.toggle(),
        hidden: () => g.playerHidden,
        setHidden: on => g.setPlayerHidden(on),
        startStation: () => g.scenario.start.atPlatform ?? null,
        teleport: target => g.teleportTo(target),
      },
      ai: () => this.ai.filter(a => !a.train.gone),
      addCompiled: (o, wanted) => this.addCompiled(o, wanted, false),
      people: () => this.people,
      roadTraffic: this.traffic.group, billboards: this.billboards.group,
      stationCrowds: on => { if (this.people) this.people.group.visible = on; else for (const v of this.stations.values()) v.crowd.mesh.visible = on; },
      setHours: h => { this.time.seconds = h * 3600; this.time.update(0); },
      setWeather: id => this.weather.set(id, true),
      restartTraffic: () => this.restartTraffic(),
      setGameUi: visible => {
        const hide = !visible || this.god.eff.hideHud;
        this.hud.setHidden(hide);
        this.profile.canvas.style.display = hide || !this.hud.visible ? 'none' : '';
        this.minimap.canvas.style.display = hide ? 'none' : '';
        this.vigPopup.el.hidden = !visible;
        if (this.tutorialCard) this.tutorialCard.el.hidden = !visible;
      },
      setKeyboardDriving: on => { this.kbDriving = on; this.keyboard.enabled = on && !this.engine.paused; },
      keep: r => { this.recordRunner = r; },
      resize: () => this.onResize(),
      applySettings: () => this.applySettings(),
      rebuildLineside: () => {
        // every track + lineside chunk again (Record Mode hid or showed the OHE masts); a short hitch, then as before
        for (const g of this.trackChunks.values()) disposeObject(g);
        this.trackChunks.clear();
        this.updateStreaming(true);
        this.pausedNeedsRender = true;
      },
      setFpsCap: fps => { this.engine.minFrameMs = fps > 0 ? 1000 / fps : 0; },
      setFrameClock: (fixedS, gate) => { this.engine.fixedFrameS = fixedS; this.engine.gate = gate; this.engine.resetClock(); },
      frameMs: () => this.engine.rawMs,
      requestRender: () => { this.pausedNeedsRender = true; },
      paused: () => this.engine.paused,
      pauseMenu: () => this.showPauseMenu(),
      resume: () => this.resume(),
      quit: () => Game.quit(),
      exit: () => {
        this.record = null;
        Object.assign(this.rec, NO_OVERRIDES());
        qualityOverride.q = null;
        this.engine.minFrameMs = 0;
        this.kbDriving = true;
        this.keyboard.enabled = !this.engine.paused;
        this.applySettings();
        this.onResize();
        this.restartTraffic();
      },
    };
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

/** Wagon type of wagon i of n in an AI rake of `stock`: container trains carry a mix of loads; a brake van at the rear. */
function freightStock(stock: string, i: number, n: number) {
  if (i === n - 1 && COACHES.brakevan) return 'brakevan';
  if (stock !== 'container-ds') return COACHES[stock] ? stock : 'goods';
  const h = Math.abs(Math.sin(i * 91.7) * 4375.85) % 1;
  return h < 0.6 ? 'container-ds' : h < 0.8 ? 'container-ds20' : h < 0.92 ? 'container-single' : 'container-empty';
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
