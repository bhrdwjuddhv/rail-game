import type { WeatherId } from '../weather';
import type { Route } from '../track/Route';
import type { ConsistSpec } from '../train/Consist';
import type { AITrainDef } from './AITrain';
import type { TimetableEntry } from './Timetable';

export interface ScenarioData {
  id: string; name: string; difficulty: string; description: string; route: string;
  start: { km: number; line: string; atPlatform?: string };
  consist: ConsistSpec;
  time: string; timeScale: number; weather: WeatherId;
  timetable: TimetableEntry[];
  aiTrains: AITrainDef[];
  endStation: string | null;
  rules: boolean;
}

/** Overrides chosen in the menus (free roam start, consist builder, time/weather). */
export interface ScenarioOverrides { startStation?: string; consist?: ConsistSpec; loco?: string; time?: string; weather?: WeatherId; timeScale?: number }

export function applyOverrides(s: ScenarioData, o: ScenarioOverrides, route: Route): ScenarioData {
  const out: ScenarioData = JSON.parse(JSON.stringify(s));
  if (o.consist) out.consist = o.consist;
  if (o.loco) out.consist = { ...out.consist, loco: o.loco };
  if (o.time) out.time = o.time;
  if (o.weather) out.weather = o.weather;
  if (o.timeScale) out.timeScale = o.timeScale;
  if (o.startStation) {
    const st = route.station(o.startStation);
    if (st) out.start = { km: st.km, line: 'main', atPlatform: st.code };
  }
  return out;
}

/** Head-of-train chainage at the start, stopped on the correct marker if starting at a platform. */
export function startHeadKm(s: ScenarioData, route: Route, trainLengthM: number) {
  if (s.start.atPlatform) {
    const st = route.station(s.start.atPlatform);
    if (st) return route.stopKm(st, trainLengthM);
  }
  return Math.max(trainLengthM / 1000 + 0.05, s.start.km);
}
