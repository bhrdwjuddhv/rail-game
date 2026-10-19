import type { StationInfo } from '@rail/shared/track/Route';

/**
 * The foot over bridge's layout (Station.ts builds it; the billboard planner hangs banners on it and keeps
 * platform boards off its stairs). No three.js here: the terrain worker loads it through BillboardSlots.
 *
 * A steel bridge across all the tracks, its deck 8.4 m above the rails, with a flight of stairs down to the
 * middle of every platform: from the deck's edge on the side of increasing km, two flights with a landing
 * between them, running along the platform.
 */
export const FOB = {
  /** deck centre above the rail top (m) */
  deck: 8.4,
  /** deck slab thickness, half the deck's width along the line */
  slab: 0.3, half: 1.5,
  /** stairs: width, steps per flight, step rise and going, landing length (m) */
  stairW: 2, steps: 24, going: 0.28, landing: 2,
};
/** the stairs' length along the platform, from the deck's edge to the foot */
export const STAIR_RUN = 2 * (FOB.steps - 1) * FOB.going + FOB.landing;

/** km of a station's foot over bridge, or null (one platform, or a junction whose own architecture has the concourse) */
export function fobKm(st: StationInfo): number | null {
  const jn = st.junction?.style;
  if (st.platforms.length < 2 || jn === 'modern' || jn === 'dravidian') return null;
  return st.km + (jn === 'colonial' ? 0.19 : 0.09);
}

/** the km range the bridge and its stairs take on the platforms (shelters, benches and boards keep out of it) */
export const fobSpan = (km: number): [number, number] => [km - FOB.half / 1000 - 0.002, km + (FOB.half + STAIR_RUN) / 1000 + 0.002];
