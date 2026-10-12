import * as THREE from 'three/webgpu';
import { GeoBatch, mat } from '../../core/GeoBatch';
import { materials } from '../../core/Materials';
import { newFrame } from '@rail/shared/track/Chainage';
import { rng } from '@rail/shared/util';
import type { FeatureData, Route } from '@rail/shared/track/Route';
import type { TerrainField } from '../TerrainField';
import { waterMaterial } from '../ChunkManager';

const M = () => materials() as unknown as Record<string, THREE.Material>;
const SANDSTONE = '#c8955c', SANDSTONE_DARK = '#a8763f';
/** a square pyramid 2 x 1 x 2, corners on the axes' diagonals: scales to any rectangular roof */
const PYRAMID = new THREE.CylinderGeometry(0, Math.SQRT2, 1, 4, 1).rotateY(Math.PI / 4);

/**
 * Step-well (baoli): a square stone pit stepping down in terraces to the water,
 * a low parapet round the rim and a domed pavilion over the head of the steps.
 * The route sinks the ground under it (Route.featureLandforms).
 */
export function buildStepwell(route: Route, field: TerrainField, ft: FeatureData): THREE.Group {
  const f = newFrame();
  route.alignment.sampleOffset(ft.km * 1000, ft.offsetM ?? 180, f);
  const cx = f.x, cz = f.z, ry = -f.heading;
  // rim at the highest of the corners just outside the pit
  let rim = -Infinity;
  for (const [u, v] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) rim = Math.max(rim, field.height(cx + u * 15, cz + v * 15));
  const b = new GeoBatch();
  const TIERS = 6, S0 = 12.5, STEP = 1.65, DROP = 1.25;
  for (let i = 0; i < TIERS; i++) {
    const outer = S0 - i * STEP, inner = outer - STEP, top = rim - i * DROP, h = 11 - i * DROP;
    // a square frame of four solid blocks reaching down below the pit floor
    for (const [x, z, w, d] of [[0, (outer + inner) / 2, outer * 2, STEP], [0, -(outer + inner) / 2, outer * 2, STEP], [(outer + inner) / 2, 0, STEP, inner * 2], [-(outer + inner) / 2, 0, STEP, inner * 2]] as const) {
      b.box(w, h, d, mat(0, top - h / 2, 0, ry).multiply(mat(x, 0, z)), i % 2 ? SANDSTONE : SANDSTONE_DARK, 'stone');
    }
  }
  // parapet with gaps on the steps' side, and a pavilion (four pillars, a dome) over the head of the steps
  for (const [x, z, w, d] of [[0, S0 + 0.5, S0 * 2 + 1, 0.8], [0, -(S0 + 0.5), S0 * 2 + 1, 0.8], [-(S0 + 0.5), 0, 0.8, S0 * 2]] as const) {
    b.box(w, 1.1, d, mat(0, rim + 0.55, 0, ry).multiply(mat(x, 0, z)), SANDSTONE, 'stone');
  }
  const px = S0 + 4;
  for (const [u, v] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) b.box(0.6, 4, 0.6, mat(0, rim + 2, 0, ry).multiply(mat(px + u * 2.2, 0, v * 2.2)), '#d9b07a', 'stone');
  b.box(6, 0.6, 6, mat(0, rim + 4.3, 0, ry).multiply(mat(px, 0, 0)), SANDSTONE, 'stone');
  b.add(new THREE.SphereGeometry(2.6, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), mat(0, rim + 4.6, 0, ry).multiply(mat(px, 0, 0)), '#e3c08e', 'stone');
  const out = b.build(M());
  // the water at the bottom
  const water = new THREE.Mesh(new THREE.PlaneGeometry((S0 - TIERS * STEP) * 2 + 0.4, (S0 - TIERS * STEP) * 2 + 0.4).rotateX(-Math.PI / 2), waterMaterial);
  water.position.set(0, rim - TIERS * DROP - 0.3, 0);
  water.rotation.y = ry;
  out.add(water);
  out.position.set(cx, 0, cz);
  return out;
}

/**
 * Ghat hill station: a scatter of colonial bungalows with red tin roofs on the
 * slope, terrace walls, a church with a spire and a clock tower, offsetM from
 * the line (default 260 m, + right).
 */
export function buildHillStation(route: Route, field: TerrainField, ft: FeatureData): THREE.Group {
  const f = newFrame();
  const side = Math.sign(ft.offsetM ?? 260) || 1, off = Math.abs(ft.offsetM ?? 260);
  const r = rng(Math.round(ft.km * 977));
  const b = new GeoBatch();
  const g = (x: number, z: number) => field.height(x, z);
  const house = (x: number, z: number, ry: number, w: number, d: number, wall: string, roof: string, floors: number) => {
    let lo = Infinity;
    for (const [u, v] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) lo = Math.min(lo, g(x + u * w / 2, z + v * d / 2));
    let hi = -Infinity;
    for (const [u, v] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) hi = Math.max(hi, g(x + u * w / 2, z + v * d / 2));
    const H = 3.2 * floors;
    // plinth down to the low side (a terrace on the slope), walls, a pitched roof with deep eaves
    b.box(w + 0.6, hi - lo + 1, d + 0.6, mat(x, (hi + lo) / 2 - 0.3, z, ry), '#8e8778', 'stone');
    b.box(w, H, d, mat(x, hi + H / 2, z, ry), wall, 'wall');
    b.add(PYRAMID, mat(x, hi + H + 1.2, z, ry, 0, 0, w * 0.58, 2.4, d * 0.58), roof, 'roof');
    for (let k = -1; k <= 1; k += 2) b.box(1.1, 1.5, 0.15, mat(x, hi + 1.8, z, ry).multiply(mat(k * w * 0.25, 0, d / 2 + 0.05)), '#3b4a5a');
  };
  for (let i = 0; i < 16; i++) {
    const km = ft.km + (r() - 0.5) * 0.7, lat = side * (off + (r() - 0.3) * 220);
    route.alignment.sampleOffset(km * 1000, lat, f);
    house(f.x, f.z, -f.heading + (r() < 0.5 ? 0 : Math.PI / 2) + (r() - 0.5) * 0.4, 8 + r() * 5, 6 + r() * 4,
      ['#f1ead8', '#e8dcc0', '#dfe7e2', '#f0e1c8'][Math.floor(r() * 4)], ['#a33a2a', '#8f3123', '#5d6d7a', '#b04a2a'][Math.floor(r() * 4)], r() < 0.3 ? 2 : 1);
  }
  // church with a spire, at the top of the town
  route.alignment.sampleOffset(ft.km * 1000, side * (off + 170), f);
  const cy = g(f.x, f.z), ry = -f.heading;
  b.box(16, 7, 9, mat(f.x, cy + 3, f.z, ry), '#d9d4c6', 'stone');
  b.add(PYRAMID, mat(f.x, cy + 8.3, f.z, ry, 0, 0, 8.6, 2.8, 5), '#59626b', 'roof');
  b.box(4, 12, 4, mat(f.x, cy + 6, f.z, ry).multiply(mat(-9, 0, 0)), '#d9d4c6', 'stone');
  b.add(PYRAMID, mat(f.x, cy + 16.5, f.z, ry).multiply(mat(-9, 0, 0, 0, 0, 0, 2.2, 9, 2.2)), '#59626b', 'roof');
  // clock tower in the square
  route.alignment.sampleOffset((ft.km + 0.12) * 1000, side * (off + 40), f);
  const ty = g(f.x, f.z);
  b.box(3.6, 15, 3.6, mat(f.x, ty + 7, f.z, -f.heading), '#c9b48f', 'stone');
  for (let k = 0; k < 4; k++) b.add(new THREE.CircleGeometry(1.1, 16), mat(f.x, ty + 12.5, f.z, -f.heading + (k * Math.PI) / 2).multiply(mat(0, 0, 1.82)), '#f3efe4');
  b.add(PYRAMID, mat(f.x, ty + 16.5, f.z, -f.heading, 0, 0, 2.2, 3, 2.2), '#8f3123', 'roof');
  return b.build(M());
}
