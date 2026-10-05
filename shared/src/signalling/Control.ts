import { Dispatcher, WorkedTrain } from '../gameplay/Timetable';
import type { Railway } from '../track/Railway';
import type { Route } from '../track/Route';
import { BlockSystem } from './BlockSystem';
import { Interlocking } from './Interlocking';
import type { Occupant } from './Signal';

/** Signalling for one running direction: its view of the route, interlocking, block signals and station working. */
export class LineControl {
  readonly interlocking: Interlocking;
  readonly block: BlockSystem;
  readonly dispatcher: Dispatcher;
  /** trains running in this direction (positions in this view's km) */
  readonly trains: WorkedTrain[] = [];

  constructor(readonly route: Route) {
    this.interlocking = new Interlocking(route.graph, route.running.offset);
    this.block = new BlockSystem(route, this.interlocking);
    this.dispatcher = new Dispatcher(route, this.interlocking, this.block);
  }

  add(t: WorkedTrain) { if (!this.trains.includes(t)) this.trains.push(t); }
  remove(t: WorkedTrain) { const i = this.trains.indexOf(t); if (i >= 0) this.trains.splice(i, 1); this.interlocking.releaseTrain(t.id); }
}

/** An occupant from another direction's view, seen in this one (km and offset mirrored). */
export function mirrorOccupant(o: Occupant, from: Route, to: Route): Occupant {
  if (from === to) return o;
  const k = (km: number) => to.viewKm(from.canonicalKm(km));
  const a = k(o.headKm), b = k(o.tailKm);
  const flip = from.mirrored !== to.mirrored ? -1 : 1;
  return { id: o.id, headKm: Math.max(a, b), tailKm: Math.min(a, b), offsetAt: km => flip * o.offsetAt(from.viewKm(to.canonicalKm(km))) };
}

/**
 * Signalling for a whole railway: one LineControl per running direction.
 * Every direction's signals and interlocking see every train (other
 * directions' trains mirrored into their km), so a crossover move or a
 * wrong-line train is protected on both lines.
 */
export class RailControl {
  readonly lines: LineControl[];

  constructor(readonly railway: Railway) {
    this.lines = railway.views.map(v => new LineControl(v));
  }

  line(id: string) { return this.lines.find(l => l.route.running.id === id) ?? this.lines[0]; }
  of(route: Route) { return this.lines.find(l => l.route === route) ?? this.lines[0]; }

  /** All trains as seen from `lc`'s view. */
  occupantsFor(lc: LineControl): Occupant[] {
    const out: Occupant[] = [...lc.trains];
    for (const other of this.lines) if (other !== lc) for (const t of other.trains) out.push(mirrorOccupant(t, other.route, lc.route));
    return out;
  }

  /** Step interlockings, station working and signal aspects (call at ~10 Hz). */
  update(dt: number, clock: number) {
    for (const lc of this.lines) {
      const occ = this.occupantsFor(lc);
      lc.interlocking.update(dt, occ);
      lc.dispatcher.update(dt, lc.trains, clock, occ);
      lc.block.update(occ);
    }
  }
}
