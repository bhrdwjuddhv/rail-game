import type { WeatherId } from '../weather';
import type { Route } from '../track/Route';
import type { ConsistSpec } from '../train/Consist';
import type { AITrainDef } from './AITrain';
import type { TimetableEntry } from './Timetable';

export interface ScenarioData {
  id: string; name: string; difficulty: string; description: string; route: string;
  /**
   * km: surveyed km. line: station line at the start platform (default: the running line).
   * track: running line on a double-line route, UP or DOWN (default DOWN); it sets the direction of travel.
   */
  start: { km: number; line?: string; atPlatform?: string; track?: string };
  consist: ConsistSpec;
  time: string; timeScale: number; weather: WeatherId;
  timetable: TimetableEntry[];
  aiTrains: AITrainDef[];
  endStation: string | null;
  rules: boolean;
}

/** Overrides chosen in the menus (free roam start, consist builder, time/weather). */
export interface ScenarioOverrides { startStation?: string; track?: string; consist?: ConsistSpec; loco?: string; time?: string; weather?: WeatherId; timeScale?: number }

export function applyOverrides(s: ScenarioData, o: ScenarioOverrides, route: Route): ScenarioData {
  const out: ScenarioData = JSON.parse(JSON.stringify(s));
  if (o.consist) out.consist = o.consist;
  if (o.loco) out.consist = { ...out.consist, loco: o.loco };
  if (o.time) out.time = o.time;
  if (o.weather) out.weather = o.weather;
  if (o.timeScale) out.timeScale = o.timeScale;
  if (o.startStation) {
    const st = route.station(o.startStation);
    if (st) out.start = { km: st.km, atPlatform: st.code, track: out.start.track };
  }
  if (o.track) out.start = { ...out.start, track: o.track, line: undefined };
  return out;
}

/** Running line the player drives on (the view to run in). */
export function startTrack(s: ScenarioData, route: Route) {
  const ids = route.runningLines.map(l => l.id);
  return s.start.track && ids.includes(s.start.track) ? s.start.track : route.double ? 'DOWN' : ids[0];
}

/** Head-of-train chainage (in `route`'s view) at the start, stopped on the correct marker if starting at a platform. */
export function startHeadKm(s: ScenarioData, route: Route, trainLengthM: number) {
  if (s.start.atPlatform) {
    const st = route.station(s.start.atPlatform);
    if (st) return route.stopKm(st, trainLengthM);
  }
  return Math.max(trainLengthM / 1000 + 0.05, route.viewKm(s.start.km));
}
