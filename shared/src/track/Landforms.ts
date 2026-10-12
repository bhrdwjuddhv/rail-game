import { clamp, fbm, ridged, smoothstep } from '../util';
import { Alignment, newFrame } from './Chainage';

/**
 * Big landscape features a route places by km and lateral offset (+ = right of
 * travel toward increasing km). The terrain adds them to its natural ground
 * (small-scale noise stays); the railway is then cut and filled through them as
 * usual, so a cliff beside the line becomes a rock cutting, a valley an
 * embankment or a viaduct.
 *
 *   hill     a rounded hill (or a peak) at km, widthM across, heightM high
 *   ridge    a long crest from km to toKm, widthM across, jagged on top
 *   plateau  like a ridge with a flat top and steep edges (a mesa)
 *   cliff    ground stepping up by heightM over widthM, away from the line, from km to toKm:
 *            a ledge for the railway with a rock face above it
 *   valley   ground falling by heightM, widthM across: a gorge when narrow and deep
 */
export interface LandformData {
  type: 'hill' | 'ridge' | 'plateau' | 'cliff' | 'valley';
  km: number; toKm?: number;
  offsetM: number; widthM: number; heightM: number;
}

export interface Landform {
  type: LandformData['type'];
  height: number; half: number;
  /** centreline (or cliff foot) in world x / z, every 40 m; one point for a hill */
  pts: { x: number; z: number }[];
  /** +1: "away from the line" is to the right of the polyline's direction */
  away: number;
  minX: number; maxX: number; minZ: number; maxZ: number;
  seed: number;
}

const STEP_M = 40;

export function compileLandforms(list: LandformData[] | undefined, a: Alignment): Landform[] {
  const f = newFrame();
  return (list ?? []).map((d, i) => {
    const pts: { x: number; z: number }[] = [];
    const s0 = d.km * 1000, s1 = d.type === 'hill' ? s0 : (d.toKm ?? d.km) * 1000;
    for (let s = s0; s <= s1 + 1e-6; s += STEP_M) {
      a.sampleOffset(clamp(s, 0, a.length), d.offsetM, f);
      pts.push({ x: f.x, z: f.z });
      if (s1 === s0) break;
    }
    const half = d.widthM / 2;
    // reach: the shape's extent plus its soft edges (a cliff's top runs on outward)
    const reach = d.type === 'cliff' ? d.widthM + 900 : d.type === 'hill' ? half : half * 1.4;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
    return {
      type: d.type, height: d.heightM, half, pts, away: Math.sign(d.offsetM) || 1,
      minX: minX - reach, maxX: maxX + reach, minZ: minZ - reach, maxZ: maxZ + reach, seed: 17 + i * 13,
    };
  });
}

/** Distance to the polyline, signed + on its "away from the line" side, and how far along it (0..1). */
function project(l: Landform, x: number, z: number) {
  const P = l.pts;
  if (P.length === 1) return { lat: Math.hypot(x - P[0].x, z - P[0].z), u: 0.5, end: 0 };
  let best = 0, bd = Infinity;
  for (let i = 0; i < P.length; i += 4) {
    const d = (P[i].x - x) ** 2 + (P[i].z - z) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  let lat = 0, md = Infinity, u = 0, end = 0;
  for (let i = Math.max(0, best - 5); i < Math.min(P.length - 1, best + 5); i++) {
    const ax = P[i].x, az = P[i].z, dx = P[i + 1].x - ax, dz = P[i + 1].z - az, L2 = dx * dx + dz * dz;
    const tRaw = ((x - ax) * dx + (z - az) * dz) / L2, t = clamp(tRaw, 0, 1);
    const px = ax + dx * t, pz = az + dz * t, dist = Math.hypot(x - px, z - pz);
    if (dist < md) {
      md = dist;
      // + right of the direction of travel (the same sense as the alignment's lateral offset)
      const side = ((x - px) * -dz + (z - pz) * dx) >= 0 ? 1 : -1;
      lat = Math.abs(((x - ax) * -dz + (z - az) * dx) / Math.sqrt(L2)) * side * l.away;
      u = (i + t) / (P.length - 1);
      // beyond the ends: how far past them (rounded ends)
      end = (i === 0 && tRaw < 0 ? -tRaw : i === P.length - 2 && tRaw > 1 ? tRaw - 1 : 0) * Math.sqrt(L2);
    }
  }
  return { lat, u, end };
}

/** Height (m) the landforms add at (x, z): may be negative (valleys). */
export function landformHeight(list: Landform[], x: number, z: number) {
  let h = 0;
  for (const l of list) {
    if (x < l.minX || x > l.maxX || z < l.minZ || z > l.maxZ) continue;
    const { lat, end } = project(l, x, z);
    const H = l.height, W = l.half;
    // the ends of long shapes round off over half their width
    const taper = 1 - smoothstep(0, Math.max(60, W), end);
    if (taper <= 0) continue;
    const a = Math.abs(lat);
    switch (l.type) {
      case 'hill': {
        if (a > W) break;
        const k = 1 - a / W;
        h += H * k * k * (3 - 2 * k) * (0.85 + 0.25 * fbm(x * 0.004, z * 0.004, 3, l.seed));
        break;
      }
      case 'ridge': {
        if (a > W) break;
        const k = 1 - a / W;
        const crest = 0.75 + 0.35 * ridged(x * 0.0022, z * 0.0022, 3, l.seed);
        h += H * k * k * (3 - 2 * k) * crest * taper;
        break;
      }
      case 'plateau': {
        const k = 1 - smoothstep(W * 0.75, W * 1.05, a);
        h += H * k * (0.95 + 0.08 * fbm(x * 0.01, z * 0.01, 2, l.seed)) * taper;
        break;
      }
      case 'cliff': {
        // flat toward the line, a steep face over widthM, then the higher ground rolling on
        if (lat <= 0) break;
        const k = smoothstep(0, l.half * 2, lat);
        const top = 1 + 0.15 * fbm(x * 0.003, z * 0.003, 3, l.seed) * smoothstep(l.half * 2, l.half * 2 + 300, lat);
        h += H * k * top * taper * (1 - smoothstep(600, 900, lat - l.half * 2) * 0.35);
        break;
      }
      case 'valley': {
        if (a > W * 1.4) break;
        const wall = 1 - smoothstep(W * 0.45, W * 1.4, a);
        h -= H * wall * taper;
        break;
      }
    }
  }
  return h;
}
