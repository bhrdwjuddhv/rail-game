// All JSON data is discovered by folder, so adding a file is enough to register it.
// Every locomotive, coach and route file is validated at load time; files with
// errors are left out (with a console message naming the file and field) so a
// broken file can never crash a run. The caller supplies the raw files (Vite
// import.meta.glob in the browser, fs in Node), keyed by path.
import { DataIssue, normaliseLoco, reportIssues, validateCoach, validateRoute } from './validate';
import type { RegionData, RouteData } from '../track/Route';
import { JunctionData, joinThroughJunction } from '../track/Junctions';
import type { CoachData, LocoData } from '../train/Consist';
import type { ScenarioData } from '../gameplay/Scenario';

export type RawFiles = Record<string, unknown>;
export interface DataFiles { regions: RawFiles; routes: RawFiles; locomotives: RawFiles; coaches: RawFiles; scenarios: RawFiles; junctions?: RawFiles }

export interface Registry {
  issues: DataIssue[];
  regions: Record<string, RegionData>;
  routes: Record<string, RouteData>;
  locos: Record<string, LocoData>;
  coaches: Record<string, CoachData>;
  scenarios: Record<string, ScenarioData>;
  /** big junction stations (data/junctions); each adds a route joining its two routes through it (routes[joined id]) */
  junctions: Record<string, JunctionData>;
  /** Locomotive by id, falling back to the first valid one (never undefined). */
  locoOrDefault(id: string | undefined): LocoData;
}

const fileName = (path: string) => path.replace(/\\/g, '/').split('/').slice(-2).join('/');

export function buildRegistry(files: DataFiles, report = true): Registry {
  const issues: DataIssue[] = [];
  const byId = <T extends { id: string }>(mods: RawFiles, check: (file: string, raw: any) => T | null = (_f, r) => r as T) => {
    const out: Record<string, T> = {};
    for (const [path, m] of Object.entries(mods)) {
      const v = check(fileName(path), m);
      if (!v) continue;
      if (out[v.id]) issues.push({ file: fileName(path), level: 'error', message: `duplicate id "${v.id}" (already used by another file) - ignored` });
      else out[v.id] = v;
    }
    return out;
  };

  const regions = byId<RegionData>(files.regions);
  const routes = byId<RouteData>(files.routes, (f, r) => validateRoute(f, r, regions, issues));
  const locos = byId<LocoData>(files.locomotives, (f, r) => normaliseLoco(f, r, issues));
  const coaches = byId<CoachData>(files.coaches, (f, r) => validateCoach(f, r, issues));
  const scenarios = byId<ScenarioData>(files.scenarios, (f, r: ScenarioData) => {
    if (!locos[r.consist?.loco]) issues.push({ file: f, level: 'warning', message: `consist.loco "${r.consist?.loco}" not found - the first valid locomotive will be used` });
    for (const c of r.consist?.coaches ?? []) if (!coaches[c.type]) issues.push({ file: f, level: 'error', message: `coach type "${c.type}" not found` });
    return r.consist?.coaches?.every(c => coaches[c.type]) ? r : null;
  });

  // junctions: each joins two routes into one more route (A -> junction -> B), by id A~junction~B
  const junctions = byId<JunctionData>(files.junctions ?? {}, (f, j: JunctionData) => {
    const bad = j.connects?.filter(c => !routes[c.route]) ?? [];
    if (bad.length || j.connects?.length !== 2) { issues.push({ file: f, level: 'error', message: `connects must name two routes that exist (${bad.map(c => c.route).join(', ') || 'two needed'})` }); return null; }
    return j;
  });
  for (const j of Object.values(junctions)) {
    const joined = joinThroughJunction(j, routes);
    if (joined) routes[joined.id] = joined;
  }

  if (report && issues.length) reportIssues(issues);
  return {
    issues, regions, routes, locos, coaches, scenarios, junctions,
    locoOrDefault: id => (id && locos[id]) || locos['ep-7'] || Object.values(locos)[0],
  };
}
