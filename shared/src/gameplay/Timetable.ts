import type { BlockSystem } from '../signalling/BlockSystem';
import type { Interlocking } from '../signalling/Interlocking';
import type { Occupant } from '../signalling/Signal';
import type { Route, StationInfo } from '../track/Route';
import { parseClock } from '../util';

export interface StopPlan {
  station: string;
  line: string;
  stop: boolean;
  arr?: number; // seconds since midnight
  dep?: number;
  dwellS?: number;
}

export interface TimetableEntry { station: string; arr?: string; dep?: string; line?: string; dwellS?: number }

export function planFromTimetable(entries: TimetableEntry[]): Map<string, StopPlan> {
  const m = new Map<string, StopPlan>();
  for (const e of entries) {
    m.set(e.station, {
      station: e.station, line: e.line ?? 'main', stop: true,
      arr: e.arr ? parseClock(e.arr) : undefined, dep: e.dep ? parseClock(e.dep) : undefined, dwellS: e.dwellS,
    });
  }
  return m;
}

export interface WorkedTrain extends Occupant {
  speed: number; // m/s
  plan: Map<string, StopPlan>;
}

interface StationState { arrived: boolean; arrivedAt: number; departed: boolean; waitHome: number; departRequested: boolean }

export interface DispatchListener {
  arrived?(train: WorkedTrain, st: StationInfo, clock: number): void;
  departed?(train: WorkedTrain, st: StationInfo, clock: number): void;
}

const MIN_DWELL = 20;

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

  /** Mark a train as already standing at a platform (scenario start). */
  startAt(train: WorkedTrain, code: string, clock: number) {
    const s = this.st(train.id, code);
    s.arrived = true;
    s.arrivedAt = clock - MIN_DWELL;
  }

  lineOf(st: StationInfo, offset: number) {
    return st.lineInfo.reduce((best, l) => (Math.abs(l.offset - offset) < Math.abs(best.offset - offset) ? l : best)).id;
  }

  stationState(trainId: string, code: string) { return this.state.get(trainId)?.get(code); }

  update(dt: number, trains: WorkedTrain[], clock: number) {
    for (const t of trains) {
      for (const st of this.route.stations) {
        if (st.exitKm < t.tailKm - 0.01 || st.entryKm - 3.5 > t.headKm) continue;
        const s = this.st(t.id, st.code);
        if (s.departed) continue;
        const plan = t.plan.get(st.code) ?? { station: st.code, line: 'main', stop: false };
        const interlocked = st.type !== 'halt';

        if (interlocked && t.headKm < st.entryKm) {
          const r = this.interlocking.requestReception(t.id, st, [plan.line], trains);
          const home = this.block.stationSignals(st.code).find(x => x.def.kind === 'home');
          if (!r && home) {
            const nearHome = home.km - t.headKm < 0.4 && home.km > t.headKm;
            s.waitHome = nearHome && Math.abs(t.speed) < 0.1 ? s.waitHome + dt : 0;
            if (s.waitHome > 25) this.interlocking.requestCallingOn(t.id, st, plan.line);
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
        const dwellOk = !plan.stop || this.departNow.has(t.id) || (s.arrived && clock - s.arrivedAt >= (plan.dwellS ?? MIN_DWELL) && (plan.dep === undefined || clock >= plan.dep - 10));
        if (interlocked && dwellOk && t.headKm > st.entryKm - 3) {
          const recv = this.interlocking.reception(st);
          const lineId = recv && recv.trainId === t.id ? recv.lineId : this.lineOf(st, t.offsetAt(Math.max(t.tailKm, Math.min(t.headKm, st.platformToKm))));
          if (!plan.stop || t.headKm > st.entryKm + 0.1 || recv?.trainId === t.id) {
            this.interlocking.requestDeparture(t.id, st, lineId);
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
