import { clamp, rng } from '../util';

/** What a train does at a stop: passengers on and off, or freight loaded / unloaded. */
export type WorkKind = 'board' | 'load' | 'unload';

export interface StopJob {
  kind: WorkKind;
  durationS: number;
  /** 0..1 */
  progress: number;
  /** passengers getting off / on (board) */
  off: number; on: number;
  /** cargo on the train (t) at the start and at the end of the job (load / unload) */
  cargoFrom: number; cargoTo: number;
}

export interface StopOptions {
  /** 0..1: how busy the station is (halt 0.3 ... junction 1) */
  busy: number;
  /** a festival crowd: many more passengers, longer boarding */
  festival?: boolean;
  /** first stop of the run: nobody gets off */
  origin?: boolean;
}

export type StopPhase = 'none' | 'ready' | 'working' | 'done' | 'closed';

/**
 * The player's work at a station stop, as a small state machine:
 *
 *   ready    stopped at a stop with work to do: "Open doors" / "Start loading"
 *   working  doors open, people getting off and on (15-30 s), or wagons being
 *            loaded / unloaded (20-40 s); `fast` runs it 4x
 *   done     all of the stop's jobs finished (doors still open for passengers)
 *   closed   doors closed (or loading over): the train may be given the road
 *
 * Event-based: the Dispatcher holds the departure until `ready(code)`, no fixed
 * timers. Pure logic (no DOM); the game drives it and draws the doors, crowd
 * and progress card from it.
 */
export class StationWork {
  passengers = 0;
  /** cargo on the train (t) */
  cargo: number;
  doorsOpen = false;
  fast = false;
  station: string | null = null;
  job: StopJob | null = null;
  private queue: WorkKind[] = [];
  private finished = new Set<string>();
  private r = rng(97);
  /** a wagon changed state during loading (index into the train's wagons, 0 = first behind the loco) */
  onWagon?: (wagon: number, loaded: boolean) => void;

  /**
   * seats: passenger capacity (0 for a goods train); wagons / payloadT: the
   * goods wagons and their full load; loaded: the train starts loaded.
   */
  constructor(readonly seats: number, readonly wagons: number, readonly payloadT: number, loaded: boolean) {
    this.cargo = loaded ? payloadT : 0;
  }

  get phase(): StopPhase {
    if (!this.station) return 'none';
    if (this.finished.has(this.station)) return 'closed';
    if (this.job) return 'working';
    return this.queue.length ? 'ready' : 'done';
  }

  /** Departure may be given from `code` (nothing to do there, or all done and doors closed). */
  ready(code: string) { return this.station !== code || this.finished.has(code) || (!this.queue.length && !this.job && !this.doorsOpen); }

  /** Stopped at a stop: what is to be done there (an empty list: nothing, the train may leave). */
  arrive(code: string, work: WorkKind[], opts: StopOptions) {
    if (this.station === code) return;
    this.station = code;
    this.queue = [...work];
    this.opts = opts;
    this.job = null;
    if (!work.length) this.finished.add(code);
  }
  private opts: StopOptions = { busy: 0.5 };

  /** The train left (or was moved): forget the stop. */
  leave() {
    this.station = null; this.queue = []; this.job = null; this.doorsOpen = false; this.fast = false;
  }

  /** Open the doors / start loading: begins the next job. */
  start() {
    if (this.job || !this.queue.length) return;
    const kind = this.queue.shift()!;
    const o = this.opts, r = this.r;
    if (kind === 'board') {
      this.doorsOpen = true;
      const off = o.origin ? 0 : Math.round(this.passengers * (0.15 + r() * 0.3) * (0.6 + o.busy * 0.6));
      const room = this.seats - (this.passengers - off);
      const want = this.seats * (0.08 + o.busy * 0.3 + r() * 0.08) * (o.festival ? 2.6 : 1) * (o.origin ? 1.6 : 1);
      const on = Math.max(0, Math.min(room, Math.round(want)));
      const durationS = clamp(10 + (off + on) / 12, 15, o.festival ? 45 : 30);
      this.job = { kind, durationS, progress: 0, off, on, cargoFrom: this.cargo, cargoTo: this.cargo };
    } else {
      const to = kind === 'load' ? this.payloadT : 0;
      const durationS = clamp(15 + this.wagons * 0.35, 20, 40);
      this.job = { kind, durationS, progress: 0, off: 0, on: 0, cargoFrom: this.cargo, cargoTo: to };
    }
  }

  update(dt: number) {
    const j = this.job;
    if (!j) return;
    const before = j.progress;
    j.progress = Math.min(1, j.progress + (dt * (this.fast ? 4 : 1)) / j.durationS);
    if (j.kind !== 'board') {
      // wagons change state one after another (from the front)
      const n = this.wagons;
      for (let i = 0; i < n; i++) {
        const at = (i + 0.5) / n;
        if (before < at && j.progress >= at) this.onWagon?.(i, j.kind === 'load');
      }
      this.cargo = j.cargoFrom + (j.cargoTo - j.cargoFrom) * j.progress;
    }
    if (j.progress >= 1) {
      if (j.kind === 'board') this.passengers += j.on - j.off;
      this.job = null;
      // unload then load runs straight on; boarding waits for "Close doors"
      if (this.queue.length && j.kind !== 'board') this.start();
      else if (!this.queue.length && !this.doorsOpen && this.station) this.finished.add(this.station);
    }
  }

  /** Close the doors (only once boarding is over). */
  close() {
    if (!this.doorsOpen || this.job) return false;
    this.doorsOpen = false;
    this.fast = false;
    if (!this.queue.length && this.station) this.finished.add(this.station);
    return true;
  }

  /** passengers aboard while boarding (live count for the card) */
  get liveCount() {
    const j = this.job;
    if (!j || j.kind !== 'board') return this.passengers;
    const t = j.progress;
      return Math.round(this.passengers - j.off * Math.min(1, t * 2) + j.on * Math.max(0, t * 2 - 1));
  }
}
