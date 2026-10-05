import { bus } from '../core/EventBus';
import { formatClock } from '../core/util';
import { GodSettings, NORMAL } from './GodMode';
import type { BlockSystem } from '../signalling/BlockSystem';
import type { Route, StationInfo } from '../track/Route';
import type { Scoring } from './Scoring';
import type { StopPlan } from './Timetable';

export interface RuleInput {
  prevHead: number; head: number; speed: number; offsetAt: (km: number) => number;
  horn: boolean; jerk: number; clock: number; limit: number; emergency: boolean; hitBuffer: boolean; dt: number;
}

/**
 * Driving rules for the player's train: SPAD, calling-on speed, overspeed,
 * whistle boards, missed stops, stop accuracy and punctuality, smoothness.
 */
export class Rules {
  finished: { success: boolean; reason: string } | null = null;
  callingOnUntil = -1;
  private whistle: { untilKm: number; heard: boolean } | null = null;
  private overspeedT = 0;
  private overspeedAnnounce = 0;
  private jerkCooldown = 0;
  private jerkEvents = 0;
  private wasEmergency = false;

  constructor(private route: Route, private block: BlockSystem, private scoring: Scoring, private plan: Map<string, StopPlan>,
    private endStation: string | null, private trainLength: number, readonly enabled: boolean,
    private cfg: () => Readonly<GodSettings> = () => NORMAL) {}

  private finish(success: boolean, reason: string) {
    if (this.finished) return;
    this.finished = { success, reason };
    if (success && this.jerkEvents < 4) this.scoring.add('smoothness', 60, 'Smooth driving throughout', 0, false);
    bus.emit('scenario-end', { success, reason });
  }

  update(i: RuleInput) {
    if (this.finished) return;
    if (i.hitBuffer) {
      if (this.enabled) { this.scoring.add('safety', -500, 'Collided with the buffer stop', i.clock); this.finish(false, 'You ran into the buffer stop at the end of the line.'); }
      else bus.emit('message', { text: 'End of line - buffer stop', kind: 'warn' });
    }
    // signals passed this step
    if (i.head > i.prevHead) {
      for (const s of this.block.signals) {
        if (s.km <= i.prevHead || s.km > i.head) continue;
        if (Math.abs(i.offsetAt(s.km) - s.def.offset) > 0.5) continue;
        bus.emit('signal-passed', { id: s.id, aspect: s.aspect });
        if (!s.isStop || s.aspect !== 'R') continue;
        if (s.callingOn) {
          const st = this.route.station(s.def.station!);
          this.callingOnUntil = st ? st.platformToKm : s.km + 0.6;
          bus.emit('message', { text: 'Calling-on: proceed at 15 km/h, be ready to stop short of any obstruction', kind: 'warn', ms: 5000 });
          continue;
        }
        const cfg = this.cfg();
        if (!cfg.obeySignals) continue; // God Mode: red signals neither stop nor penalise
        bus.emit('spad', { signalId: s.id });
        if (this.enabled && cfg.spadPenalty) {
          this.scoring.add('signals', -1000, `SPAD - passed signal ${s.id} at danger`, i.clock);
          this.finish(false, `Signal Passed At Danger: ${s.id}. In real service this ends the run.`);
          return;
        }
        bus.emit('message', { text: `Passed ${s.id} at danger (free roam - no penalty)`, kind: 'warn' });
      }
      // whistle boards
      for (const b of this.route.boards) {
        if (b.kind !== 'whistle' || b.km <= i.prevHead || b.km > i.head) continue;
        this.whistle = { untilKm: b.km + 0.55, heard: false };
      }
    }
    if (this.whistle) {
      if (i.horn) this.whistle.heard = true;
      if (i.head > this.whistle.untilKm) {
        if (this.enabled) {
          if (this.whistle.heard) this.scoring.add('horn', 10, 'Horn sounded at whistle board', i.clock, false);
          else this.scoring.add('horn', -30, 'Missed whistle board - sound the horn', i.clock);
        }
        this.whistle = null;
      }
    }
    if (!this.enabled) return;

    // overspeed (limit already includes turnouts / calling-on)
    const kmph = Math.abs(i.speed) * 3.6;
    if (kmph > i.limit + 3 && this.cfg().speedEnforcement) {
      if (this.overspeedT === 0) this.scoring.add('speed', -20, `Overspeed: ${Math.round(kmph)} in a ${i.limit} km/h limit`, i.clock);
      this.overspeedT += i.dt;
      this.overspeedAnnounce += i.dt;
      const rate = kmph > i.limit + 15 ? 8 : 3;
      if (this.scoring.enabled) this.scoring.totals.speed -= rate * i.dt;
      if (this.overspeedAnnounce > 5) { this.overspeedAnnounce = 0; bus.emit('message', { text: 'Still over the speed limit!', kind: 'penalty' }); }
    } else { this.overspeedT = 0; this.overspeedAnnounce = 0; }

    // ride quality
    this.jerkCooldown -= i.dt;
    if (Math.abs(i.jerk) > 1.6 && Math.abs(i.speed) > 1 && this.jerkCooldown <= 0) {
      this.jerkCooldown = 3;
      this.jerkEvents++;
      this.scoring.add('smoothness', -5, 'Rough handling - passengers jolted', i.clock);
    }
    if (i.emergency && !this.wasEmergency && kmph > 10) this.scoring.add('safety', -25, 'Emergency brake application', i.clock);
    this.wasEmergency = i.emergency;
  }

  arrived(st: StationInfo, clock: number, head: number) {
    const p = this.plan.get(st.code);
    if (!p?.stop || !this.enabled) return;
    const target = this.route.stopKm(st, this.trainLength);
    const err = (head - target) * 1000;
    const pts = Math.abs(err) <= 2 ? 100 : Math.max(-60, Math.round(100 - Math.abs(err) * 6));
    this.scoring.add('stops', pts, `Stopped ${Math.abs(err).toFixed(1)} m ${err > 0 ? 'past' : 'short of'} the mark at ${st.name}`, clock);
    let late = 0;
    if (p.arr !== undefined) {
      late = clock - p.arr;
      const pp = late <= 60 ? 80 : Math.max(-100, Math.round(80 - (late - 60) / 12));
      this.scoring.add('punctuality', pp, late <= 60 ? `On time at ${st.name}` : `${Math.round(late / 60)} min late at ${st.name} (due ${formatClock(p.arr)})`, clock);
    }
    bus.emit('station-arrival', { code: st.code, name: st.name, errorM: err, lateS: late });
    if (this.endStation === st.code) this.finish(true, `Arrived at ${st.name}. Run complete.`);
  }

  departed(st: StationInfo, arrived: boolean, clock: number) {
    const p = this.plan.get(st.code);
    if (!this.enabled || !p?.stop) return;
    if (!arrived && this.cfg().mustStop) this.scoring.add('stops', -200, `Missed booked stop at ${st.name}`, clock);
    else if (p.dep !== undefined && clock - p.dep > 120) this.scoring.add('punctuality', -20, `Late departure from ${st.name}`, clock);
    bus.emit('station-departure', { code: st.code });
  }
}
