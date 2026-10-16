import type { BlockSystem } from '../signalling/BlockSystem';
import type { Interlocking } from '../signalling/Interlocking';
import type { Occupant } from '../signalling/Signal';
import { MIDDLE_LINE, type Route, type StationInfo } from '../track/Route';
import { parseClock } from '../util';
import type { WorkKind } from './StationWork';

export interface StopPlan {
  station: string;
  line: string;
  stop: boolean;
  /** leave this station on the other running line (double line): its crossover is set in the departure route */
  exitLine?: string;
  arr?: number; // seconds since midnight
  dep?: number;
  dwellS?: number;
  /** work at this stop (default: passengers board at a passenger train's stops) */
  work?: WorkKind[];
  /** a festival crowd at this stop (more passengers, longer boarding) */
  festival?: boolean;
}

export interface TimetableEntry { station: string; arr?: string; dep?: string; line?: string; dwellS?: number; exitLine?: string; work?: WorkKind[]; festival?: boolean }

/** `line` defaults to the running line of the train's direction (resolved by the Dispatcher). */
export function planFromTimetable(entries: TimetableEntry[]): Map<string, StopPlan> {
  const m = new Map<string, StopPlan>();
  for (const e of entries) {
    m.set(e.station, {
      station: e.station, line: e.line ?? '', stop: true, exitLine: e.exitLine,
      arr: e.arr ? parseClock(e.arr) : undefined, dep: e.dep ? parseClock(e.dep) : undefined, dwellS: e.dwellS,
      work: e.work, festival: e.festival,
    });
  }
  return m;
}

export interface WorkedTrain extends Occupant {
  speed: number; // m/s
  plan: Map<string, StopPlan>;
  /** precedence class: 4 high-speed trainset, 3 express / passenger, 1 goods (default 2) */
  priority?: number;
  /** the speed it runs at on the open line (km/h), for overtaking decisions */
  cruiseKmph?: number;
  name?: string;
  /** the player's train (never held in a loop while the middle line is free for the train behind) */
  player?: boolean;
  /** never turned into a loop to let another train by (the player's Route Mode journey) */
  neverGiveWay?: boolean;
  /** where it leaves the railway (AI traffic despawning), if before the end of the line */
  leavesKm?: number;
}

interface StationState {
  arrived: boolean; arrivedAt: number; departed: boolean; waitHome: number; departRequested: boolean;
  /** giving way here: received into the loop and held until this train has passed */
  giveWay?: string; giveWaySince?: number; giveWayTold?: boolean;
  /** sent along the middle line from here to overtake this train (told once) */
  overtakeTold?: boolean;
  /** when it was first ready to leave from inside the station (a big junction lets them out in that order) */
  readySince?: number;
}

export interface DispatchListener {
  arrived?(train: WorkedTrain, st: StationInfo, clock: number): void;
  departed?(train: WorkedTrain, st: StationInfo, clock: number): void;
  /** `train` was turned into the loop at `st` for `follower` to overtake */
  givingWay?(train: WorkedTrain, st: StationInfo, follower: WorkedTrain): void;
  /** `train` leaves `st` along the middle line to overtake `leader`, rejoining its line at `to` (or later) */
  overtaking?(train: WorkedTrain, st: StationInfo, leader: WorkedTrain, to: StationInfo): void;
}

const MIN_DWELL = 20;
/** a train never waits in a loop longer than this for an overtake (s): a stalled follower cannot block it for ever */
const GIVE_WAY_MAX_S = 360;
/** a follower is slowed by the leading train's signals within about this distance (m) */
const HEADWAY_M = 1500;

/**
 * Plays station master for every train: sets reception routes as a train
 * approaches, falls back to calling-on when all lines are blocked, and grants
 * departure after the booked dwell and departure time.
 */
export class Dispatcher {
  private state = new Map<string, Map<string, StationState>>();
  listeners: DispatchListener[] = [];
  /** trains allowed to leave as soon as their route can be set (tutorial practice, God Mode auto-drive) */
  readonly departNow = new Set<string>();
  /** trains whose routes are not set automatically (God Mode "Manual points") */
  readonly manual = new Set<string>();
  /**
   * Trains whose departure waits for their station work (doors closed,
   * loading done) instead of a minimum dwell: ready(code) gives the road.
   */
  readonly gates = new Map<string, (code: string) => boolean>();

  constructor(private route: Route, private interlocking: Interlocking, private block: BlockSystem) {}

  private st(trainId: string, code: string) {
    let t = this.state.get(trainId);
    if (!t) this.state.set(trainId, (t = new Map()));
    let s = t.get(code);
    if (!s) t.set(code, (s = { arrived: false, arrivedAt: 0, departed: false, waitHome: 0, departRequested: false }));
    return s;
  }

  /** Forget a train's station progress (after a teleport). */
  resetTrain(trainId: string) { this.state.delete(trainId); }

  /** Giving way: has the overtaking train gone by (or given up)? Held in the loop until then. */
  private overtaken(t: WorkedTrain, st: StationInfo, s: StationState, trains: WorkedTrain[], clock: number) {
    if (!s.giveWay) return true;
    const f = trains.find(x => x.id === s.giveWay);
    // the wait is counted from arrival in the loop; until then the departure is simply not given
    if (t.headKm >= st.entryKm) s.giveWaySince ??= clock;
    else if (f) return false;
    if (!f || f.tailKm > st.exitKm || clock - (s.giveWaySince ?? clock) > GIVE_WAY_MAX_S) { s.giveWay = undefined; return true; }
    return false;
  }

  /**
   * The train asked not to wait any longer for a train to pass (Skip wait): it stops giving way at every
   * station it is at; the other train follows it out instead.
   */
  cancelGiveWay(trainId: string) {
    for (const s of this.state.get(trainId)?.values() ?? []) { s.giveWay = undefined; s.giveWaySince = undefined; }
  }

  /** Mark a train as already standing at a platform (scenario start). */
  startAt(train: WorkedTrain, code: string, clock: number) {
    const s = this.st(train.id, code);
    s.arrived = true;
    s.arrivedAt = clock - MIN_DWELL;
  }

  /** The station line at a lateral offset (and km: a junction's two bay halves share an offset). */
  lineOf(st: StationInfo, offset: number, km?: number) {
    const here = km === undefined ? st.lineInfo : st.lineInfo.filter(l => km >= l.fromKm - 0.01 && km <= l.toKm + 0.01);
    return (here.length ? here : st.lineInfo).reduce((best, l) => (Math.abs(l.offset - offset) < Math.abs(best.offset - offset) ? l : best)).id;
  }

  stationState(trainId: string, code: string) { return this.state.get(trainId)?.get(code); }

  /** Line a plan asks for at a station, or this direction's running line. */
  private planLine(st: StationInfo, line: string | undefined) {
    return line && st.lineInfo.some(l => l.id === line) ? line : this.route.running.id;
  }

  /**
   * The crossover at a station that takes a train from `fromLine` onto the
   * running line `exitLine` (by lateral offsets), or undefined.
   */
  crossoverTo(st: StationInfo, fromLine: string, exitLine: string) {
    const off = (id: string) => st.lineInfo.find(l => l.id === id)?.offset ?? this.route.runningLines.find(l => l.id === id)?.offset;
    const a = off(fromLine), b = off(exitLine);
    if (a === undefined || b === undefined || a === b) return undefined;
    return this.route.graph.switches.find(sw => sw.def.station === st.code && sw.def.kind === 'crossover' && Math.abs(sw.def.from - a) < 0.5 && Math.abs(sw.def.to - b) < 0.5)?.def.id;
  }

  /**
   * Change the line a train will be received on at `st` (Free Roam "Route
   * ahead"). A route already set is cancelled only while the train is far
   * enough from the station for the points to move (the next update sets
   * the new one). Returns false when it is too late.
   */
  reroute(t: WorkedTrain, st: StationInfo, line: string) {
    if (t.headKm > st.entryKm - 0.35) return false;
    const p = t.plan.get(st.code);
    t.plan.set(st.code, { station: st.code, line, stop: p?.stop ?? false, arr: p?.arr, dep: p?.dep, dwellS: p?.dwellS, exitLine: p?.exitLine });
    const r = this.interlocking.find(t.id, st, 'reception');
    if (r && r.lineId !== line) this.interlocking.release(r);
    return true;
  }

  /**
   * Where a train of this direction can stand aside at a station: its own loop
   * (beyond the running line, on its side), else the middle line shared by both
   * directions; undefined if neither.
   */
  loopAt(st: StationInfo) {
    const run = this.route.running.offset;
    return st.lineInfo.filter(l => l.id !== this.route.running.id && Math.sign(l.offset) === Math.sign(run) && Math.abs(l.offset) > Math.abs(run))
      .sort((a, b) => Math.abs(a.offset - run) - Math.abs(b.offset - run))[0] ?? st.lineInfo.find(l => l.id === MIDDLE_LINE);
  }

  /**
   * Precedence: should `t` give way at `st` to a train behind it? Yes when a
   * train of higher priority (or the same, but clearly faster) is following and
   * would catch up before `t` could clear the next station with a loop. Only
   * where this direction has a loop long enough for `t`. Returns the follower.
   */
  overtaker(t: WorkedTrain, st: StationInfo, trains: WorkedTrain[]): WorkedTrain | null {
    if (t.neverGiveWay) return null;
    if (st.type === 'halt' || !this.loopAt(st) || t.headKm - t.tailKm > st.exitKm - st.entryKm - 0.25) return null;
    // the player's train with the middle line free through here: the faster train goes round along it, the player is not held
    if (t.player && this.route.middle && this.interlocking.middleFree(st, this.route.middleSectionEnd(st) ?? undefined)) return null;
    const cruise = (x: WorkedTrain) => x.cruiseKmph ?? 80;
    // the leader: its cruising speed, or slower if it is dawdling (never assumed below half of it)
    const vt = Math.min(cruise(t), Math.max(Math.abs(t.speed) * 3.6, cruise(t) * 0.5)), pt = t.priority ?? 2;
    const next = this.route.stations.find(s => s.entryKm > st.exitKm && s.type !== 'halt' && this.loopAt(s));
    const clearKm = next ? next.exitKm : this.route.lengthKm;
    let best: WorkedTrain | null = null, soonest = Infinity;
    for (const f of trains) {
      if (f === t || f.headKm >= t.tailKm || t.tailKm - f.headKm > 15) continue;
      // already overtaking along the middle line: nothing to stand aside for
      if (this.route.middle && Math.abs(f.offsetAt(f.headKm)) < 1) continue;
      const pf = f.priority ?? 2, vf = cruise(f);
      if (!(pf > pt || (pf === pt && vf > vt + 15)) || vf <= vt + 5) continue;
      // where the follower closes up to the leading train's signals, at their cruising speeds
      const gap = Math.max(0, (t.tailKm - f.headKm) * 1000 - HEADWAY_M);
      const catchS = gap / ((vf - vt) / 3.6);
      const atKm = t.headKm + (vt / 3.6) * catchS / 1000;
      if (atKm < clearKm + 0.5 && catchS < soonest) { soonest = catchS; best = f; }
    }
    return best;
  }

  /**
   * Overtaking on the open line: should `t` leave `st` along the middle line?
   * Yes when a slower, less important train (or the same class, clearly slower)
   * is on the running line ahead, before the next station, and `t` would catch
   * it up there. Not if `t` is booked to stop at a halt in between (no platform
   * on the middle line). Returns that train and the section's far station.
   */
  middleOvertake(t: WorkedTrain, st: StationInfo, trains: WorkedTrain[]): { leader: WorkedTrain; to: StationInfo } | null {
    const to = this.route.middleSectionEnd(st);
    if (!to || to.entryKm - st.exitKm < 1.2) return null;
    // a train leaving the railway before the section's end has nowhere to rejoin its line (it would stand on the middle line)
    if ((t.leavesKm ?? Infinity) < to.entryKm + 0.3) return null;
    for (const h of this.route.stations) if (h.type === 'halt' && h.km > st.exitKm && h.km < to.entryKm && t.plan.get(h.code)?.stop) return null;
    const cruise = (x: WorkedTrain) => x.cruiseKmph ?? 80;
    const vt = cruise(t), pt = t.priority ?? 2, run = this.route.running.offset;
    let best: WorkedTrain | null = null, nearest = Infinity;
    for (const l of trains) {
      if (l === t || l.tailKm <= t.headKm || l.headKm > to.entryKm + 0.3) continue;
      if (Math.abs(l.offsetAt(l.headKm) - run) > 1) continue; // only a train on the running line is in the way
      const pl = l.priority ?? 2, vl = Math.min(cruise(l), Math.max(Math.abs(l.speed) * 3.6, cruise(l) * 0.5));
      if (!(pt > pl || (pt === pl && vt > vl + 15)) || vt <= vl + 5) continue;
      const gap = Math.max(0, (l.tailKm - t.headKm) * 1000 - HEADWAY_M);
      const atKm = t.headKm + (vt / 3.6) * (gap / ((vt - vl) / 3.6)) / 1000;
      if (atKm < to.entryKm && l.tailKm - t.headKm < nearest) { nearest = l.tailKm - t.headKm; best = l; }
    }
    return best ? { leader: best, to } : null;
  }

  /** `occupants`: every train on the railway (defaults to `trains`), for line-clear checks. */
  update(dt: number, trains: WorkedTrain[], clock: number, occupants: Occupant[] = trains) {
    for (const t of trains) {
      if (this.manual.has(t.id)) continue;
      for (const st of this.route.stations) {
        if (st.exitKm < t.tailKm - 0.01 || st.entryKm - 3.5 > t.headKm) continue;
        const s = this.st(t.id, st.code);
        if (s.departed) continue;
        const plan = t.plan.get(st.code) ?? { station: st.code, line: '', stop: false };
        let line = this.planLine(st, plan.line);
        const interlocked = st.type !== 'halt';

        // precedence (no line booked for this train here): turn it into the loop for a faster, more
        // important train behind; decided until its reception route is set, then kept
        if (interlocked && !plan.line && t.headKm < st.entryKm && t.headKm > st.entryKm - 3.5) {
          const recv = this.interlocking.find(t.id, st, 'reception');
          if (!recv) {
            const f = this.overtaker(t, st, trains);
            if (f?.id !== s.giveWay) { s.giveWay = f?.id; s.giveWaySince = undefined; s.giveWayTold = false; }
          } else if (s.giveWay && recv.lineId !== this.loopAt(st)?.id) s.giveWay = undefined; // the loop was not free
          if (s.giveWay) line = this.loopAt(st)!.id;
        }

        // a route in is asked for by the first train coming (not by one behind it, which would hold the station's single
        // reception while the train ahead waits at the home signal), and not while the train still stands in another
        // station waiting to leave (it would hold this one's reception for nothing)
        const queued = trains.some(o => o !== t && !this.manual.has(o.id) && o.headKm > t.headKm && o.headKm < st.entryKm && !this.interlocking.find(o.id, st, 'reception'));
        const held = this.route.stations.some(o => o !== st && o.type !== 'halt' && o.km < st.km && t.headKm >= o.entryKm && t.headKm <= o.exitKm && !this.interlocking.find(t.id, o, 'departure'));
        if (interlocked && t.headKm < st.entryKm && !queued && !held && !this.interlocking.find(t.id, st, 'reception') || (interlocked && t.headKm < st.entryKm && this.interlocking.find(t.id, st, 'reception'))) {
          // along the middle line (from the last station): its own home; back to the line booked (or the
          // running line), else straight on along the middle line
          const fromMiddle = this.route.middle && Math.abs(t.offsetAt(t.headKm)) < 1;
          // a route set while the train was on its running line, which then came along the middle line (or the other
          // way): it waits at the other home signal; set again while there is time for the points
          const had = this.interlocking.find(t.id, st, 'reception');
          // (also when it already stands at that signal: only while it is short of all the route's points)
          if (had && !!had.fromMiddle !== fromMiddle && t.headKm < Math.min(...had.needs.map(n => n.sw.def.rampStart)) - 0.01) this.interlocking.release(had);
          // a big junction: a train calling here gets a platform line, never a through line (each train its own
          // turn round the platforms, so they are all used); a goods train runs round on the avoiding line
          let prefs = fromMiddle ? [line, MIDDLE_LINE] : [line], only = false;
          // (one coming along the middle line too: it crosses back to its running line before the ladder)
          if (st.platformLines?.length && plan.line) only = true; // a booked line here (a bay): wait for it, never a through line
          else if (st.platformLines?.length) {
            // (a train calling here stands at a platform anyway: giving way never sends it onto a through line)
            if (plan.stop) {
              const pl = st.platformLines, k = [...t.id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % pl.length;
              prefs = [...pl.slice(k), ...pl.slice(0, k)];
              only = true;
            } else if ((t.priority ?? 2) <= 1 && st.avoiding && !s.giveWay) prefs = [st.avoiding, line];
          }
          // a train calling here stands at a platform: never received onto the middle line or a line without one
          if (plan.stop && !only && !plan.line) {
            const withPf = new Set(st.platforms.flatMap(p => p.lines));
            const pf = st.lineInfo.map(l => l.id).filter(id => withPf.has(id) && id !== MIDDLE_LINE);
            if (pf.length) { prefs = [...prefs.filter(id => pf.includes(id)), ...pf.filter(id => !prefs.includes(id))]; only = true; }
          }
          const r = this.interlocking.requestReception(t.id, st, prefs, occupants, fromMiddle, only);
          if (r && s.giveWay && !s.giveWayTold && r.lineId === line) {
            s.giveWayTold = true;
            const f = trains.find(x => x.id === s.giveWay);
            if (f) for (const l of this.listeners) l.givingWay?.(t, st, f);
          }
          const home = this.block.stationSignals(st.code).find(x => x.def.kind === 'home' && (x.def.line === MIDDLE_LINE) === fromMiddle);
          if (!r && home && !(only && st.platformLines?.length)) { // (never called on into an occupied junction platform: it waits for a free one)
            const nearHome = home.km - t.headKm < 0.4 && home.km > t.headKm;
            s.waitHome = nearHome && Math.abs(t.speed) < 0.1 ? s.waitHome + dt : 0;
            if (s.waitHome > 25) this.interlocking.requestCallingOn(t.id, st, line, occupants, fromMiddle);
          }
        }

        // arrival
        const inPlatform = t.headKm >= st.platformFromKm && t.headKm <= st.platformToKm + 0.05;
        if (plan.stop && !s.arrived && inPlatform && Math.abs(t.speed) < 0.05) {
          s.arrived = true;
          s.arrivedAt = clock;
          for (const l of this.listeners) l.arrived?.(t, st, clock);
        }

        // departure authority
        const gate = this.gates.get(t.id);
        const dwellOk = (!plan.stop || this.departNow.has(t.id) || (s.arrived && (gate ? gate(st.code) : clock - s.arrivedAt >= (plan.dwellS ?? MIN_DWELL)) && (plan.dep === undefined || clock >= plan.dep - 10)))
          && this.overtaken(t, st, s, trains, clock);
        if (interlocked && dwellOk && t.headKm > st.entryKm - 3) {
          const recv = this.interlocking.reception(st);
          const at = Math.max(t.tailKm, Math.min(t.headKm, st.platformToKm));
          const lineId = recv && recv.trainId === t.id ? recv.lineId : this.lineOf(st, t.offsetAt(at), at);
          // only once the train is received here (or inside the station): a departure route set ahead of that
          // could be for the wrong line (a train arriving along the middle line is received onto its own)
          if (t.headKm > st.entryKm + 0.1 || recv?.trainId === t.id) {
            s.readySince ??= clock;
            // a big junction: every departure on this side merges onto the one running line, so whoever asked
            // first each time the exit came free would always win and a train further down the list could wait
            // for ever. They leave in the order they became ready: none asks while one ready before it still waits.
            const behind = !!st.platformLines?.length && !this.interlocking.find(t.id, st, 'departure') && trains.some(o => {
              const os = o !== t && !this.manual.has(o.id) ? this.stationState(o.id, st.code) : undefined;
              return !!os && !os.departed && os.readySince !== undefined && os.readySince < s.readySince! && !this.interlocking.find(o.id, st, 'departure');
            });
            if (behind) continue;
            const crossTo = plan.exitLine ? this.crossoverTo(st, lineId, plan.exitLine) : undefined;
            // overtaking along the middle line to the next station, when a slower train is in the way and
            // the section is free; otherwise the normal departure
            const ov = !crossTo && !this.interlocking.find(t.id, st, 'departure') ? this.middleOvertake(t, st, trains) : null;
            const viaMiddle = ov && this.interlocking.sectionFree(st, ov.to, t.id)
              ? this.interlocking.requestDeparture(t.id, st, lineId, undefined, occupants, { viaMiddle: true, to: ov.to }) : null;
            if (viaMiddle && ov && !s.overtakeTold) { s.overtakeTold = true; for (const l of this.listeners) l.overtaking?.(t, st, ov.leader, ov.to); }
            if (!viaMiddle) this.interlocking.requestDeparture(t.id, st, lineId, crossTo, occupants);
            s.departRequested = true;
          }
        }

        if (t.tailKm > st.exitKm) {
          s.departed = true;
          for (const l of this.listeners) l.departed?.(t, st, clock);
        }
      }
    }
  }
}
