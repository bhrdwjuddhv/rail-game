// Game data, discovered by folder (adding a JSON file is enough to register it)
// and validated by the shared registry.
import { buildRegistry } from '@rail/shared/data/registry';

const reg = buildRegistry({
  regions: import.meta.glob('../../data/regions/*.json', { eager: true, import: 'default' }),
  routes: import.meta.glob('../../data/routes/*.json', { eager: true, import: 'default' }),
  locomotives: import.meta.glob('../../data/locomotives/*.json', { eager: true, import: 'default' }),
  coaches: import.meta.glob('../../data/coaches/*.json', { eager: true, import: 'default' }),
  scenarios: import.meta.glob('../../data/scenarios/*.json', { eager: true, import: 'default' }),
});

export const DATA_ISSUES = reg.issues;
export const REGIONS = reg.regions;
export const ROUTES = reg.routes;
export const LOCOS = reg.locos;
export const COACHES = reg.coaches;
export const SCENARIOS = reg.scenarios;
export const locoOrDefault = reg.locoOrDefault;
