import { AITrain, AITrainDef, AI_LOCO_LEN } from '../gameplay/AITrain';
import type { RailControl, LineControl } from '../signalling/Control';
import type { Route, StationInfo } from '../track/Route';
import type { JunctionData } from '../track/Junctions';
import { rng } from '../util';

/** coach and wagon lengths of the AI rakes (over couplers) */
const COACH_M = 23.54, WAGON_M = 10.7;

export interface JunctionTrafficConfig {
  seed: number;
  /** trains to keep in the station (standing, arriving or leaving inside its limits) */
  inStation: number;
  /** high-speed trainset (loco id and length) calling now and then, or none */
  bullet?: { loco: string; lengthM: number } | null;
}

/** What a train is, for the departure boards: its name, kind and platform line here. */
export interface JunctionTrainInfo { name: string; kind: 'express' | 'mail' | 'local' | 'goods' | 'bullet'; line?: string; passing?: boolean }

/**
 * Keeps a big junction busy. Trains come in from both routes (each direction
 * of the joined route), are routed by the dispatcher to a free platform line,
 * stand for their dwell and leave towards the other route; locals start from
 * and terminate in the bays; goods trains run round on the avoiding line;
 * the bullet train calls now and then. A new train is sent in whenever fewer
 * than `inStation` are there or on their way, so the station is never empty.
 * Runs only while active (the player within a few km): the caller says when.
 * One platform per side is kept for the player's train when it is on its way in.
 */
export class JunctionTraffic {
  readonly trains: AITrain[] = [];
  readonly info = new Map<AITrain, JunctionTrainInfo>();
  onSpawn?: (t: AITrain, view: Route) => void;
  onDespawn?: (t: AITrain) => void;
  private r: () => number;
  private n = 0;
  private cooldown = 0;
  private populated = false;
  /** directions whose arrival bay is kept for the player's train (a journey ending here) */
  private reservedBay = new Set<Route>();

  /** Keep this direction's arrival bay free: no locals terminate in it (the player's journey ends there). */
  reserveBay(view: Route) { this.reservedBay.add(view); }

  constructor(private ctl: RailControl, readonly j: JunctionData, private cfg: JunctionTrafficConfig) {
    this.r = rng(cfg.seed);
  }

  private views() { return this.ctl.lines.map(lc => ({ lc, st: lc.route.station(this.j.code)! })).filter(x => x.st); }

  /** In the station (between its limits), in its view's km. */
  private inStation(t: AITrain, st: StationInfo) { return t.headKm > st.entryKm && t.tailKm < st.exitKm; }

  /** trains here now (any view) */
  presentCount() {
    let n = 0;
    for (const t of this.trains) {
      const v = this.views().find(x => x.lc.trains.includes(t));
      if (v && this.inStation(t, v.st)) n++;
    }
    return n;
  }

  private pick<T>(a: T[]) { return a[Math.floor(this.r() * a.length) % a.length]; }

  /** Free lines among `ids` at a station (nothing on them, nobody routed into them). */
  private freeLines(lc: LineControl, st: StationInfo, ids: string[]) {
    const occ = this.ctl.occupantsFor(lc);
    return ids.filter(id => lc.interlocking.lineClear(st, id, occ, '') && !lc.interlocking.routes.some(r => r.station === st && r.lineId === id));
  }

  private make(lc: LineControl, st: StationInfo, kind: JunctionTrainInfo['kind'], def: Partial<AITrainDef> & { startKm: number; line: string }, passing = false): AITrain {
    const names = this.j.trainNames;
    const name = kind === 'goods' ? `Goods ${100 + (this.n % 900)}` : kind === 'bullet' ? 'Vande Gati Bullet' : this.pick(names[kind]);
    const coaches = kind === 'express' ? 16 + Math.floor(this.r() * 4) : kind === 'mail' ? 14 + Math.floor(this.r() * 4) : kind === 'local' ? 8 : 40;
    const full: AITrainDef = {
      id: `jt-${this.j.code}-${++this.n}`, name,
      maxKmph: kind === 'goods' ? 65 : kind === 'local' ? 90 : kind === 'bullet' ? 160 : 110,
      wagons: kind === 'bullet' ? 0 : coaches, carLengthM: kind === 'goods' ? WAGON_M : COACH_M, kind: kind === 'goods' ? 'goods' : 'passenger',
      stops: kind === 'goods' || passing ? [] : [{ station: st.code, line: '', dwellS: Math.round(this.j.dwellS[0] + this.r() * (this.j.dwellS[1] - this.j.dwellS[0])) }],
      // out of sight beyond the exit, and before the next station (its loops and signals are not for these trains)
      // (passenger stock starts briskly: each departure has to clear the exit ladder before the next can leave)
      accel: kind === 'goods' ? 0.2 : 0.4,
      despawnKm: Math.min(st.exitKm + 2.5, ...lc.route.stations.filter(o => o.type !== 'halt' && o.entryKm > st.exitKm).map(o => o.entryKm - 0.3)), track: lc.route.running.id,
      ...(kind === 'bullet' && this.cfg.bullet ? { loco: this.cfg.bullet.loco, lengthM: this.cfg.bullet.lengthM } : {}),
      ...def,
    } as AITrainDef;
    const t = new AITrain(full, lc.route, lc.block);
    this.trains.push(t);
    this.info.set(t, { name: full.name, kind, passing: passing || kind === 'goods' });
    this.onSpawn?.(t, lc.route);
    return t;
  }

  private lengthOf(kind: JunctionTrainInfo['kind']) {
    if (kind === 'bullet') return this.cfg.bullet?.lengthM ?? 72;
    const c = kind === 'express' ? 19 : kind === 'mail' ? 17 : kind === 'local' ? 8 : 40;
    return AI_LOCO_LEN + c * (kind === 'goods' ? WAGON_M : COACH_M);
  }

  /** Put trains standing at free platforms at once (the station is busy when the player first gets there). */
  private populate(clock: number) {
    const want = Math.min(this.cfg.inStation, 3 + Math.floor(this.r() * 2));
    for (let i = 0; i < want; i++) {
      const v = this.pick(this.views());
      const free = this.freeLines(v.lc, v.st, v.st.platformLines ?? []);
      if (!free.length) continue;
      const kind = this.pick<JunctionTrainInfo['kind']>(['express', 'express', 'mail', 'local']);
      const line = this.pick(free), head = v.lc.route.stopKm(v.st, this.lengthOf(kind));
      const t = this.make(v.lc, v.st, kind, { startKm: head, line });
      v.lc.dispatcher.startAt(t, v.st.code, clock - this.r() * 100);
      this.info.get(t)!.line = line;
    }
  }

  /**
   * One step. `active`: the junction is near enough to matter (no new trains otherwise; those
   * running go on). `player`: the player's view and head km, to keep a platform free for it.
   */
  update(dt: number, clock: number, active: boolean, player?: { view: Route; headKm: number }) {
    for (const t of this.trains) if (!t.gone) t.update(dt);
    for (const t of [...this.trains]) {
      if (!t.gone) continue;
      this.trains.splice(this.trains.indexOf(t), 1);
      this.info.delete(t);
      this.onDespawn?.(t);
    }
    // the platform each train was given (departure boards)
    for (const t of this.trains) {
      const v = this.views().find(x => x.lc.trains.includes(t)), i = this.info.get(t);
      if (!v || !i || i.line) continue;
      const r = v.lc.interlocking.find(t.id, v.st, 'reception');
      if (r) i.line = r.lineId;
    }
    if (!active) return;
    if (!this.populated) { this.populated = true; this.populate(clock); }
    this.cooldown -= dt;
    if (this.cooldown > 0) return;
    // still to arrive or standing (a train pulling out over the ladder is on its way: not counted)
    const coming = this.trains.filter(t => !this.info.get(t)?.passing && this.views().some(v => v.lc.trains.includes(t) && t.headKm <= v.st.platformToKm + 0.02));
    // trains take minutes to come in over the ladders: up to three on their way at once, so enough stand at the platforms
    const inbound = coming.filter(t => this.views().some(v => v.lc.trains.includes(t) && t.headKm < v.st.platformFromKm)).length;
    if (coming.length >= this.cfg.inStation + 2) return;
    this.cooldown = 10 + this.r() * 15;
    // with three on their way in (they come in one at a time over each ladder), only a local starting from a bay
    this.spawnOne(player, inbound >= 3);
  }

  /**
   * Trains on one side ready to leave but not yet given the road. A side lets a train out only every minute and a
   * half or so (each must clear the exit ladder before the next can be routed over it), so no more are sent in
   * on a side while two are already queuing to leave.
   */
  private queued(lc: LineControl, st: StationInfo) {
    return this.trains.filter(t => {
      if (!lc.trains.includes(t)) return false;
      const s = lc.dispatcher.stationState(t.id, st.code);
      return !!s && s.readySince !== undefined && !s.departed && !lc.interlocking.find(t.id, st, 'departure');
    }).length;
  }

  private spawnOne(player?: { view: Route; headKm: number }, bayOnly = false) {
    const views = this.views().filter(x => this.queued(x.lc, x.st) < 2);
    if (!views.length) return;
    const v = this.pick(views), { lc, st } = v;
    // the player's train on its way in on this side: keep a platform for it (no more trains in ahead of it)
    const playerComing = player && player.view === lc.route && player.headKm < st.platformFromKm && player.headKm > st.entryKm - 8;
    const freePl = this.freeLines(lc, st, st.platformLines ?? []);
    const roll = this.r();
    // a local starting from the bay at this end
    if ((roll < 0.25 || bayOnly) && st.bayOut && this.freeLines(lc, st, [st.bayOut]).length) {
      const bay = st.lineInfo.find(l => l.id === st.bayOut)!;
      const head = Math.min(bay.toKm - 0.04, st.platformToKm - 0.01);
      const t = this.make(lc, st, 'local', { startKm: head, line: st.bayOut });
      lc.dispatcher.startAt(t, st.code, -1e9);
      this.info.get(t)!.line = st.bayOut;
      return;
    }
    if (bayOnly) return;
    // inbound: in from 2.2 km out on this side's running line (before its distant signal), if that stretch is clear,
    // and wholly clear of the station before it (never appearing inside another station's limits)
    const prev = Math.max(0, ...lc.route.stations.filter(o => o.type !== 'halt' && o.exitKm < st.entryKm).map(o => o.exitKm));
    const head = Math.max(st.entryKm - 2.2, prev + 0.2 + this.lengthOf('express') / 1000);
    if (head > st.entryKm - 0.5) return;
    const occ = this.ctl.occupantsFor(lc);
    const busy = occ.some(o => o.headKm > head - 2 && o.tailKm < head + 1.5 && Math.abs(o.offsetAt(Math.min(o.headKm, Math.max(o.tailKm, head))) - lc.route.running.offset) < 1.5);
    if (busy || head < 0.3) return;
    // a goods train round the avoiding line (it passes: not counted as calling)
    if (roll > 0.25 && roll < 0.4 && st.avoiding) { this.make(lc, st, 'goods', { startKm: head, line: lc.route.running.id }); return; }
    // an express running through on the through line at speed (no stop: it never takes a platform)
    if (roll >= 0.55 && roll < 0.65) { this.make(lc, st, 'express', { startKm: head, line: lc.route.running.id, maxKmph: 120 }, true); return; }
    if (playerComing && freePl.length <= 1) return;
    // a local terminating in the bay at this end
    if (roll > 0.4 && roll < 0.55 && st.bayIn && !this.reservedBay.has(lc.route) && this.freeLines(lc, st, [st.bayIn]).length) {
      const bay = st.lineInfo.find(l => l.id === st.bayIn)!;
      const t = this.make(lc, st, 'local', { startKm: head, line: lc.route.running.id, endAtKm: bay.toKm - 0.012, endDwellS: 90, despawnKm: bay.toKm + 1, stops: [{ station: st.code, line: st.bayIn, dwellS: 90 }] });
      this.info.get(t)!.line = st.bayIn;
      return;
    }
    if (!freePl.length) return;
    const kind: JunctionTrainInfo['kind'] = this.cfg.bullet && roll > 0.9 ? 'bullet' : this.pick(['express', 'express', 'mail', 'local']);
    this.make(lc, st, kind, { startKm: head, line: lc.route.running.id });
  }

  /** Everything out (the junction is left behind, or the run ends). */
  reset() {
    for (const t of [...this.trains]) { t.gone = true; this.onDespawn?.(t); }
    this.trains.length = 0;
    this.info.clear();
    this.populated = false;
  }
}
