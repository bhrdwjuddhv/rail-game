import { AITrain, AITrainDef } from '../gameplay/AITrain';
import type { LineControl } from '../signalling/Control';
import type { Route } from '../track/Route';
import { rng } from '../util';

export interface TrafficKind {
  kind: 'goods' | 'passenger';
  /** relative weight when picking a train */
  weight: number;
  cars: [number, number];
  carLengthM: number;
  maxKmph: number;
  /** wagon type (data/coaches id) the rake is made of; default the generic goods wagon / express coaches */
  stock?: string;
}

export interface TrafficConfig {
  seed: number;
  /** mean time between trains (s) */
  headwayS: number;
  /** spawn this far ahead of the player (km), beyond draw distance */
  aheadKm: number;
  /** remove trains once their tail is this far behind the player (km) */
  behindKm: number;
  /** keep at least this much clear track between trains at spawn (km) */
  minGapKm: number;
  kinds: TrafficKind[];
}

export const DEFAULT_TRAFFIC: TrafficConfig = {
  seed: 1, headwayS: 420, aheadKm: 9, behindKm: 3, minGapKm: 2.5,
  kinds: [
    { kind: 'passenger', weight: 1, cars: [16, 22], carLengthM: 24.14, maxKmph: 110 },
    { kind: 'goods', weight: 1, cars: [30, 45], carLengthM: 11.3, maxKmph: 65 },
  ],
};

/** Dedicated freight corridors: goods trains only, double-stack container and covered wagon rakes. */
export const FREIGHT_TRAFFIC: TrafficConfig = {
  ...DEFAULT_TRAFFIC, headwayS: 360,
  kinds: [
    { kind: 'goods', weight: 2, cars: [42, 56], carLengthM: 19.2, maxKmph: 100, stock: 'container-ds' },
    { kind: 'goods', weight: 1, cars: [55, 80], carLengthM: 15.0, maxKmph: 75, stock: 'boxcar' },
  ],
};

/**
 * Scheduled AI trains on one running line, kept in a window around the
 * player: spawned ahead (out of sight) and removed once well behind. Pure
 * logic with a seeded random, so the same seed and inputs give the same
 * traffic (the server can run it for online rooms).
 *
 * The trains run in `line`'s view: they move toward increasing km there, which
 * on the opposite line of a double track is toward the player.
 */
export class TrafficManager {
  readonly trains: AITrain[] = [];
  onSpawn?: (t: AITrain, k: TrafficKind) => void;
  onDespawn?: (t: AITrain) => void;
  private rand: () => number;
  private timer = 0;
  private seq = 0;
  private primed = false;

  constructor(readonly line: LineControl, readonly cfg: TrafficConfig = DEFAULT_TRAFFIC) {
    this.rand = rng(cfg.seed);
    this.timer = this.nextGap();
  }

  get route(): Route { return this.line.route; }

  private nextGap() { return this.cfg.headwayS * (0.6 + this.rand() * 0.8); }

  private pickKind() {
    const ks = this.cfg.kinds, total = ks.reduce((a, k) => a + k.weight, 0);
    let r = this.rand() * total;
    for (const k of ks) if ((r -= k.weight) <= 0) return k;
    return ks[ks.length - 1];
  }

  /** Is [tail - gap, head + gap] free of trains on this line? */
  private clear(headKm: number, lengthKm: number) {
    const g = this.cfg.minGapKm;
    return this.line.trains.every(t => t.tailKm > headKm + g || t.headKm < headKm - lengthKm - g);
  }

  /** Move a spawn point back out of station yards, so a train never appears inside interlocked limits. */
  private outsideYards(km: number) {
    for (const st of this.route.stations) if (km > st.entryKm - 2.2 && km < st.exitKm + 0.6) km = st.entryKm - 2.2;
    return km;
  }

  /** Spawn one train with its head at `headKm` (this line's km). Returns null if there is no room. */
  spawn(headKm: number, kind = this.pickKind()): AITrain | null {
    const cars = kind.cars[0] + Math.floor(this.rand() * (kind.cars[1] - kind.cars[0] + 1));
    const lengthKm = (20.56 + cars * kind.carLengthM) / 1000;
    const km = this.outsideYards(headKm);
    if (km - lengthKm < 0.05 || km > this.route.lengthKm - 0.3 || !this.clear(km, lengthKm)) return null;
    const def: AITrainDef = {
      id: `${this.route.running.id}-T${++this.seq}`, name: `${kind.kind === 'goods' ? 'Goods' : 'Express'} ${100 + this.seq}`,
      startKm: km, line: this.route.running.id, maxKmph: kind.maxKmph, wagons: cars, stops: [],
      despawnKm: this.route.lengthKm - 0.4, track: this.route.running.id, carLengthM: kind.carLengthM, kind: kind.kind, stock: kind.stock,
    };
    const t = new AITrain(def, this.route, this.line.block);
    this.trains.push(t);
    this.line.add(t);
    this.onSpawn?.(t, kind);
    return t;
  }

  private remove(t: AITrain) {
    this.trains.splice(this.trains.indexOf(t), 1);
    this.line.remove(t);
    this.onDespawn?.(t);
  }

  /** Drop every train (e.g. after a teleport) and fill the approach again on the next update. */
  reset() {
    for (const t of [...this.trains]) this.remove(t);
    this.primed = false;
  }

  /**
   * @param playerKm the player's position in this line's km
   */
  update(dt: number, playerKm: number) {
    const c = this.cfg;
    if (!this.primed) {
      // trains already on their way: spread over the out-of-sight part of the approach
      this.primed = true;
      const spacingKm = Math.max(c.minGapKm + 1, (c.headwayS * 25) / 1000); // ~90 km/h headway in km
      for (let km = playerKm - c.aheadKm; km < playerKm - 3; km += spacingKm) this.spawn(km);
    }
    for (const t of this.trains) t.update(dt);
    for (const t of [...this.trains]) {
      if (t.gone || t.tailKm > playerKm + c.behindKm || t.headKm < playerKm - c.aheadKm - 3) this.remove(t);
    }
    this.timer -= dt;
    if (this.timer <= 0 && this.spawn(playerKm - c.aheadKm)) this.timer = this.nextGap();
    else if (this.timer <= 0) this.timer = 20; // no room yet: try again shortly
  }
}
