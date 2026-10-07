import type { WeatherId } from '../environment/Weather';

/** A point beside the line: surveyed km, metres right of the centreline (Down direction), metres above formation. */
export interface TrackPoint { km: number; offset: number; h: number }

/**
 * God Mode -> Bug check cameras: a fixed view of each place a visual bug was
 * reported, to check the fix quickly. `eye`/`look` place the free camera;
 * `cab` drives the train there and uses the cab view instead (inside tunnels,
 * where the free camera stays above the ground).
 */
export interface BugCamera {
  id: string;
  label: string;
  eye?: TrackPoint;
  look?: TrackPoint;
  /** train head km (surveyed); default a little before the eye */
  trainKm?: number;
  cab?: boolean;
  hours?: number;
  weather?: WeatherId;
}

/** Presets by route id. */
export const BUG_CAMERAS: Record<string, BugCamera[]> = {
  'ghat-express': [
    { id: 'tex-station', label: '1.1 Textures: Sonagarh platform', eye: { km: 0.96, offset: -14, h: 3 }, look: { km: 1.03, offset: -5, h: 1 } },
    { id: 'ballast', label: '1.2 Ballast bed, open line', eye: { km: 5.0, offset: 6.5, h: 1.7 }, look: { km: 5.025, offset: -2.65, h: 0.4 } },
    { id: 'ballast-curve', label: '1.2 Ballast on a curve + bridge', eye: { km: 26.3, offset: 9, h: 4 }, look: { km: 26.42, offset: 0, h: 0 } },
    { id: 'crossover', label: '1.3 Crossover km 15.2 (top down)', eye: { km: 15.25, offset: 0, h: 34 }, look: { km: 15.252, offset: 0, h: 0 } },
    { id: 'crossover-low', label: '1.3 Crossover frog and blades (close)', eye: { km: 15.205, offset: 5, h: 2.2 }, look: { km: 15.222, offset: -2, h: 0.4 } },
    { id: 'turnout-station', label: '1.3 Station turnouts, Rampur Jn', eye: { km: 20.05, offset: -9, h: 6 }, look: { km: 20.14, offset: -6, h: 0 } },
    { id: 'roof-top', label: '1.4 Station roof from above', eye: { km: 0.94, offset: -24, h: 14 }, look: { km: 1.0, offset: -7, h: 4 } },
    { id: 'roof-under', label: '1.4 Station roof from below', eye: { km: 0.99, offset: -7.5, h: 2.4 }, look: { km: 1.02, offset: -7.5, h: 5.5 } },
    { id: 'walls', label: '1.5 Buildings and walls on slopes (town)', eye: { km: 18.8, offset: -40, h: 6 }, look: { km: 18.95, offset: -60, h: 2 } },
    { id: 'ohe', label: '1.6 OHE masts and wires', eye: { km: 8.0, offset: 7, h: 3.5 }, look: { km: 8.07, offset: -1, h: 5.5 } },
    { id: 'strips', label: '1.7 Lineside objects (cess)', eye: { km: 3.0, offset: 9, h: 2.2 }, look: { km: 3.02, offset: 5, h: 0 } },
    { id: 'trees', label: '1.8 Trees and grass, fields', eye: { km: 9.0, offset: 22, h: 2.2 }, look: { km: 9.05, offset: 60, h: 4 } },
    { id: 'tunnel-above', label: '1.9 Tunnel No. 1 from above (rain)', eye: { km: 35.45, offset: 30, h: 70 }, look: { km: 35.55, offset: 0, h: 0 }, weather: 'rain' },
    { id: 'tunnel-portal', label: '1.9 Tunnel No. 1 portal', eye: { km: 35.12, offset: 8, h: 7 }, look: { km: 35.25, offset: 0, h: 3 } },
    { id: 'tunnel-inside', label: '1.9 Inside Tunnel No. 2, rain (cab)', trainKm: 37.9, cab: true, weather: 'rain' },
    { id: 'night-station', label: '1.10 Station at night', eye: { km: 0.95, offset: -14, h: 3 }, look: { km: 1.03, offset: -5, h: 1 }, hours: 21 },
  ],
};
