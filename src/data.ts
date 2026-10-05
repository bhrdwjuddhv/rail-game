// All JSON data is discovered by folder, so adding a file is enough to register it.
// Every locomotive, coach and route file is validated at load time; files with
// errors are left out (with a console message naming the file and field) so a
// broken file can never crash a run.
import { DataIssue, normaliseLoco, reportIssues, validateCoach, validateRoute } from './core/DataValidator';
import type { RegionData, RouteData } from './track/Route';
import type { CoachData, LocoData } from './train/Consist';
import type { ScenarioData } from './gameplay/Scenario';

const fileName = (path: string) => path.split('/').slice(-2).join('/');

const byId = <T extends { id: string }>(mods: Record<string, unknown>, check: (file: string, raw: any) => T | null = (_f, r) => r as T) => {
  const out: Record<string, T> = {};
  for (const [path, m] of Object.entries(mods)) {
    const v = check(fileName(path), m);
    if (!v) continue;
    if (out[v.id]) DATA_ISSUES.push({ file: fileName(path), level: 'error', message: `duplicate id "${v.id}" (already used by another file) - ignored` });
    else out[v.id] = v;
  }
  return out;
};

export const DATA_ISSUES: DataIssue[] = [];

export const REGIONS = byId<RegionData>(import.meta.glob('../data/regions/*.json', { eager: true, import: 'default' }));
export const ROUTES = byId<RouteData>(import.meta.glob('../data/routes/*.json', { eager: true, import: 'default' }), (f, r) => validateRoute(f, r, REGIONS, DATA_ISSUES));
export const LOCOS = byId<LocoData>(import.meta.glob('../data/locomotives/*.json', { eager: true, import: 'default' }), (f, r) => normaliseLoco(f, r, DATA_ISSUES));
export const COACHES = byId<CoachData>(import.meta.glob('../data/coaches/*.json', { eager: true, import: 'default' }), (f, r) => validateCoach(f, r, DATA_ISSUES));
export const SCENARIOS = byId<ScenarioData>(import.meta.glob('../data/scenarios/*.json', { eager: true, import: 'default' }), (f, r: ScenarioData) => {
  if (!LOCOS[r.consist?.loco]) DATA_ISSUES.push({ file: f, level: 'warning', message: `consist.loco "${r.consist?.loco}" not found - the first valid locomotive will be used` });
  for (const c of r.consist?.coaches ?? []) if (!COACHES[c.type]) DATA_ISSUES.push({ file: f, level: 'error', message: `coach type "${c.type}" not found` });
  return r.consist?.coaches?.every(c => COACHES[c.type]) ? r : null;
});

/** Locomotive by id, falling back to the first valid one (never undefined). */
export function locoOrDefault(id: string | undefined): LocoData {
  return (id && LOCOS[id]) || LOCOS['ep-7'] || Object.values(LOCOS)[0];
}

if (DATA_ISSUES.length) reportIssues(DATA_ISSUES);
