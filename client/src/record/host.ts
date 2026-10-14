import type * as THREE from 'three/webgpu';
import type { AudioEngine } from '../audio/AudioEngine';
import type { TrainAudio } from '../audio/TrainAudio';
import type { CameraContext, CameraManager } from '../camera/CameraManager';
import type { RenderSystem } from '../core/Renderer';
import type { Lighting } from '../environment/Lighting';
import type { TimeOfDay } from '../environment/TimeOfDay';
import type { Weather, WeatherId } from '../environment/Weather';
import type { TrainView } from '../train/Coach';
import type { PeopleSystem } from '../world/people/People';
import type { TerrainField } from '../world/TerrainField';
import type { AITrain } from '@rail/shared/gameplay/AITrain';
import type { RailControl } from '@rail/shared/signalling/Control';
import type { Railway } from '@rail/shared/track/Railway';
import type { Route } from '@rail/shared/track/Route';
import type { Consist } from '@rail/shared/train/Consist';
import type { LocoSystems } from '@rail/shared/train/LocoSystems';
import type { DriveStyle } from '@rail/shared/record/RecordTrain';

/** A train a camera can follow: drawn by `view`, running in `route`'s km. */
export interface CamTarget { view: TrainView; route: Route; headKm: number; speed: number; eye: THREE.Vector3 }

/** The player's train driven by Record Mode's train settings (God Mode's auto-driver underneath). */
export interface PlayerDrive { kmph: number; style: DriveStyle; obeySignals: boolean; obeyLimits: boolean }

/**
 * What Record Mode changes in the running game. Game reads these every step /
 * frame; outside Record Mode they stay at their defaults (no effect).
 */
export interface RecordOverrides {
  /** world speed: 0 frozen, 0.1..2 slow / fast motion (sim steps and frame-driven effects) */
  scale: number;
  /** clock speed (null: the scenario's / God Mode's) */
  timeScale: number | null;
  forceGreen: boolean;
  hideSignals: boolean;
  /** headlight beam and fog glow strength multipliers */
  beam: number; glow: number;
  /** AI traffic level (-1 off, 0..3 as Settings) or null for the Settings one */
  traffic: number | null;
  /** hear the world from here instead of the camera */
  listener: (() => THREE.Vector3) | null;
  playerDrive: PlayerDrive | null;
  /** cameras follow this train instead of the player's */
  cameraTarget: (() => CamTarget | null) | null;
  /** fixed output size (null: fit the window) */
  output: { w: number; h: number } | null;
  /** render scale over the Settings one (null: as Settings) */
  renderScale: number | null;
  noAdaptive: boolean;
}

export const NO_OVERRIDES = (): RecordOverrides => ({
  scale: 1, timeScale: null, forceGreen: false, hideSignals: false, beam: 1, glow: 1, traffic: null,
  listener: null, playerDrive: null, cameraTarget: null, output: null, renderScale: null, noAdaptive: false,
});

/** Per-step and per-frame work of Record Mode's trains (kept running as AI traffic after leaving it). */
export interface RecordRunner {
  sim(dt: number): void;
  /** dt: real time (cameras); wdt: world time (frozen 0, slow motion scaled) */
  frame(dt: number, wdt: number): void;
  /** after the cameras moved, before the frame is drawn (lens, focus) */
  afterCamera?(dt: number): void;
  /** right after the frame is drawn (the canvas can be read: bookmark thumbnails) */
  afterRender?(): void;
}

export interface RecordHost {
  readonly scene: THREE.Scene; readonly world: THREE.Group; readonly origin: THREE.Vector3; readonly rcam: THREE.PerspectiveCamera;
  readonly cameras: CameraManager; readonly canvas: HTMLCanvasElement; readonly rs: RenderSystem;
  readonly field: TerrainField; readonly railway: Railway; readonly route: Route; readonly ctl: RailControl;
  readonly time: TimeOfDay; readonly weather: Weather; readonly lighting: Lighting;
  readonly audio: AudioEngine | null; trainAudio(): TrainAudio | undefined;
  readonly rec: RecordOverrides;
  scenarioId: string;
  keys(code: string): boolean;
  cameraContext(dt: number): CameraContext;
  /** register a camera mode; returns its index */
  addCamera(m: import('../camera/CameraManager').CameraMode): number;
  player: {
    view: TrainView; consist: Consist; sys: LocoSystems;
    route(): Route; headKm(): number; speed(): number; offsetAt(km: number): number;
    setSpeedNow(kmph: number): void; toggleDoors(): void;
    /** the studio started from the main menu: no train of yours (hidden, outside the signalling) */
    hidden(): boolean; setHidden(on: boolean): void;
    /** the station chosen at the start */
    startStation(): string | null;
    teleport(target: { station?: string; km?: number; line?: string }): Promise<void>;
  };
  ai(): { train: AITrain; view: TrainView; route: Route }[];
  /** every train in a view, for keeping clear */
  addCompiled(o: THREE.Object3D, stillWanted: () => boolean): void;
  people(): PeopleSystem | null;
  roadTraffic: THREE.Object3D; billboards: THREE.Object3D;
  stationCrowds(on: boolean): void;
  setHours(h: number): void;
  setWeather(id: WeatherId): void;
  restartTraffic(): void;
  /** HUD, map, track profile and touch controls hidden (Record Mode) or as before */
  setGameUi(visible: boolean): void;
  /** the player's train driven from the keyboard (Record Mode "Drive this train") */
  setKeyboardDriving(on: boolean): void;
  /** set when Record Mode is left with "keep trains": the game keeps running them */
  keep(r: RecordRunner | null): void;
  resize(): void;
  applySettings(): void;
  setFpsCap(fps: number): void;
  /** wall time of the last frame (ms) */
  frameMs(): number;
  requestRender(): void;
  /** the game is paused (its menu open) */
  paused(): boolean;
  pauseMenu(): void;
  resume(): void;
  /** back to the main menu */
  quit(): void;
  exit(): void;
}

/** A point picked on the track (a click in the world or on the map): surveyed km, and the line clicked (null from the map). */
export interface TrackHit { km: number; x: number; y: number; z: number; line: string | null }

/** What Record Mode's parts share: the host, messages, picking, freeze-aware changes, undo. */
export interface Studio {
  h: RecordHost;
  toast(text: string, warn?: boolean): void;
  /** the next click on the track (world or map) goes to `cb`; Esc cancels */
  pick(label: string, cb: (hit: TrackHit) => void): void;
  /** a click on the route map: true when a pick took it */
  mapClick(km: number): boolean;
  /** world frozen: train setting changes wait for the unfreeze */
  frozen(): boolean;
  apply(fn: () => void): void;
  uiVisible(): boolean;
  pushUndo(label: string, undo: () => void): void;
}
