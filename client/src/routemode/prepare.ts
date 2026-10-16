import { COACHES, JUNCTIONS, ROUTES, SCENARIOS } from '../data';
import { type Journey, journeyScenario, RailNetwork } from '@rail/shared/routemode/Journey';

/** scenario id of a Route Mode journey (built from the journey each time a run starts) */
export const ROUTE_MODE_ID = 'route-mode';

/**
 * Make a journey playable: its way built into one route (registered with the routes) and the
 * journey as the Route Mode scenario. Done before every start, also after a reload (restart,
 * a loco change), from the journey kept with the run's overrides. Returns the scenario id, or
 * null when the stations no longer connect (data changed since it was saved).
 */
export function prepareJourney(j: Journey): string | null {
  const net = new RailNetwork(ROUTES, JUNCTIONS);
  const path = net.pathFor(j.from, j.to, j.via);
  if (!path) return null;
  const route = net.compose(path);
  ROUTES[route.id] = route;
  SCENARIOS[ROUTE_MODE_ID] = journeyScenario(j, route, COACHES);
  return ROUTE_MODE_ID;
}
