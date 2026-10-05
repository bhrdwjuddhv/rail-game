import * as THREE from 'three/webgpu';
import { GeoBatch, mat } from '../../core/GeoBatch';
import { rng } from '../../core/util';
import { newFrame } from '../../track/Chainage';
import type { RoadDef, Route } from '../../track/Route';
import type { LevelCrossingView } from '../../infrastructure/LevelCrossing';
import type { TerrainField } from '../TerrainField';

type VType = 'car' | 'auto' | 'truck' | 'bus' | 'bike' | 'tractor' | 'cart';
const SPEED: Record<VType, number> = { car: 13, auto: 9, truck: 10, bus: 11, bike: 12, tractor: 6, cart: 2.5 };
const LEN: Record<VType, number> = { car: 4.2, auto: 2.8, truck: 8, bus: 11, bike: 2, tractor: 4.5, cart: 4.5 };
const COLORS = ['#c0392b', '#ecf0f1', '#2c3e50', '#7f8c8d', '#2980b9', '#f39c12', '#16a085', '#8e44ad'];

const geos = new Map<VType, THREE.BufferGeometry>();
function vehicleGeo(t: VType) {
  let g = geos.get(t);
  if (g) return g;
  const b = new GeoBatch();
  const wheels = (xs: number[], z: number, r: number) => { for (const x of xs) for (const s of [-1, 1]) b.cyl(r, r, 0.25, 10, mat(x, r, s * z, 0, Math.PI / 2), '#1a1a1a'); };
  switch (t) {
    case 'car':
      b.box(4.2, 0.75, 1.75, mat(0, 0.75, 0), '#ffffff');
      b.box(2.3, 0.6, 1.6, mat(-0.2, 1.4, 0), '#ffffff');
      b.box(2.25, 0.5, 1.62, mat(-0.2, 1.4, 0), '#23303a');
      wheels([-1.3, 1.3], 0.8, 0.33);
      break;
    case 'auto':
      b.box(2.6, 1.0, 1.35, mat(0, 0.85, 0), '#2e7d32');
      b.box(2.4, 0.15, 1.4, mat(-0.1, 1.75, 0), '#f9d71c');
      b.box(0.1, 0.8, 1.3, mat(0.9, 1.3, 0), '#23303a');
      wheels([-0.8], 0.6, 0.25); b.cyl(0.25, 0.25, 0.2, 10, mat(1.1, 0.25, 0, 0, Math.PI / 2), '#1a1a1a');
      break;
    case 'truck':
      b.box(2.2, 2.2, 2.3, mat(2.9, 1.5, 0), '#e67e22');
      b.box(5.6, 2.3, 2.4, mat(-1.0, 1.75, 0), '#ffffff');
      b.box(0.1, 0.8, 2.1, mat(4.01, 1.9, 0), '#23303a');
      wheels([-2.5, -1.2, 2.8], 1.05, 0.5);
      break;
    case 'bus':
      b.box(11, 2.6, 2.5, mat(0, 1.75, 0), '#ffffff');
      b.box(10.4, 0.8, 2.52, mat(0, 2.2, 0), '#23303a');
      wheels([-3.6, 3.4], 1.1, 0.5);
      break;
    case 'bike':
      b.box(1.8, 0.4, 0.3, mat(0, 0.7, 0), '#ffffff');
      b.cyl(0.18, 0.2, 0.7, 6, mat(-0.1, 1.3, 0), '#5d4037');
      b.add(new THREE.SphereGeometry(0.15, 8, 6), mat(-0.05, 1.8, 0), '#111');
      wheels([-0.7, 0.7], 0, 0.3);
      break;
    case 'tractor':
      b.box(2.4, 1.0, 1.2, mat(0.8, 1.0, 0), '#c62828');
      b.box(1.2, 1.4, 1.3, mat(-0.7, 1.6, 0), '#c62828');
      b.cyl(0.75, 0.75, 0.4, 12, mat(-0.8, 0.75, 0.9, 0, Math.PI / 2), '#1a1a1a');
      b.cyl(0.75, 0.75, 0.4, 12, mat(-0.8, 0.75, -0.9, 0, Math.PI / 2), '#1a1a1a');
      wheels([1.5], 0.7, 0.4);
      break;
    case 'cart':
      b.box(2.6, 0.2, 1.6, mat(-0.8, 1.0, 0), '#8d6e63');
      b.cyl(0.7, 0.7, 0.12, 10, mat(-0.8, 0.7, 0.9, 0, Math.PI / 2), '#5d4037');
      b.cyl(0.7, 0.7, 0.12, 10, mat(-0.8, 0.7, -0.9, 0, Math.PI / 2), '#5d4037');
      for (const s of [-0.45, 0.45]) { b.box(1.7, 0.9, 0.7, mat(1.6, 1.15, s), '#e0dccf'); b.box(0.5, 0.5, 0.4, mat(2.6, 1.5, s), '#e0dccf'); }
      b.box(2.4, 0.08, 0.08, mat(1.0, 1.2, 0), '#5d4037');
      break;
  }
  g = b.geometry('std')!;
  geos.set(t, g);
  return g;
}

const paints = new Map<string, THREE.Material>();
const paint = (c: string) => { let m = paints.get(c); if (!m) paints.set(c, (m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.2, color: c }))); return m; };

interface Lane { road: RoadDef; dir: 1 | -1; lateral: number; elevation: (t: number) => number; pos: (t: number, out: THREE.Vector3) => number; lc?: LevelCrossingView; length: number }
interface Car { mesh: THREE.Mesh; lane: Lane; t: number; speed: number; type: VType; honk: number }

/**
 * Road traffic on level-crossing roads and town roads. Vehicles queue at
 * closed barriers; a few honk while waiting (the audio system listens via onHonk).
 */
export class Traffic {
  readonly group = new THREE.Group();
  private lanes: Lane[] = [];
  private cars: Car[] = [];
  private r = rng(77);
  onHonk?: (pos: THREE.Vector3) => void;

  constructor(route: Route, field: TerrainField, lcs: LevelCrossingView[]) {
    const f = newFrame();
    for (const road of route.roads) {
      if (road.kind === 'lc') {
        const lc = lcs.find(l => l.road === road);
        for (const dir of [1, -1] as const) {
          const lat = dir * -1.8;
          this.lanes.push({
            road, dir, lateral: lat, lc, length: road.halfLength * 2,
            elevation: t => field.lcRoadElevation(road, t),
            pos: (t, out) => { out.set(road.ax + road.dx * t - road.dz * lat, field.lcRoadElevation(road, t), road.az + road.dz * t + road.dx * lat); return Math.atan2(-road.dz * dir, road.dx * dir); },
          });
        }
      } else {
        for (const dir of [1, -1] as const) {
          const lat = road.offset! + dir * 1.8;
          this.lanes.push({
            road, dir, lateral: lat, length: (road.toKm! - road.fromKm!) * 1000,
            elevation: () => 0,
            pos: (t, out) => {
              route.alignment.sampleOffset(road.fromKm! * 1000 + t, lat, f);
              out.set(f.x, f.y - 0.07, f.z);
              return -f.heading + (dir < 0 ? Math.PI : 0);
            },
          });
        }
      }
    }
  }

  private spawn(lane: Lane, t: number) {
    const roll = this.r();
    const town = lane.road.kind === 'parallel';
    const type: VType = roll < 0.3 ? 'car' : roll < 0.52 ? 'auto' : roll < 0.68 ? 'bike' : roll < 0.8 ? 'truck' : roll < 0.88 ? 'bus' : roll < 0.96 || town ? 'tractor' : 'cart';
    const color = type === 'car' || type === 'bus' || type === 'bike' ? COLORS[Math.floor(this.r() * COLORS.length)] : '#ffffff';
    const mesh = new THREE.Mesh(vehicleGeo(type), paint(color));
    mesh.castShadow = true;
    this.group.add(mesh);
    this.cars.push({ mesh, lane, t, speed: SPEED[type] * (0.8 + this.r() * 0.4), type, honk: 5 + this.r() * 20 });
  }

  update(dt: number, cam: THREE.Vector3) {
    const p = new THREE.Vector3();
    // keep a handful of vehicles on lanes near the camera
    for (const lane of this.lanes) {
      lane.pos(lane.dir > 0 ? (lane.road.kind === 'lc' ? 0 : lane.length / 2) : 0, p);
      const near = p.distanceTo(cam) < 1300;
      const count = this.cars.filter(c => c.lane === lane).length;
      if (near && count < (lane.road.kind === 'lc' ? 3 : 4) && this.r() < dt * 0.3) {
        const start = lane.road.kind === 'lc' ? -lane.dir * 550 : lane.dir > 0 ? 0 : lane.length;
        this.spawn(lane, start);
      }
    }
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i];
      const L = c.lane;
      let target = SPEED[c.type];
      // stop at closed barriers (and for any approaching train at unmanned LCs)
      if (L.lc && (L.lc.closing || L.lc.closed > 0.05)) {
        const stopT = -L.dir * (L.lc.gateT + 3);
        const ahead = (stopT - c.t) * L.dir;
        if (ahead > -1) target = Math.min(target, Math.max(0, (ahead - 1) * 0.8));
      }
      // keep distance to the car in front
      for (const o of this.cars) {
        if (o === c || o.lane !== L) continue;
        const gap = (o.t - c.t) * L.dir - (LEN[o.type] + LEN[c.type]) / 2 - 2;
        if (gap > -2 && gap < 25) target = Math.min(target, Math.max(0, gap * 0.6));
      }
      c.speed += Math.max(-6 * dt, Math.min(2 * dt, target - c.speed));
      c.t += c.speed * dt * L.dir;
      if (c.speed < 0.2 && L.lc && (c.honk -= dt) < 0) { c.honk = 6 + this.r() * 18; L.pos(c.t, p); this.onHonk?.(p.clone()); }
      const ry = L.pos(c.t, p);
      c.mesh.position.copy(p);
      c.mesh.rotation.y = ry;
      const out = L.road.kind === 'lc' ? Math.abs(c.t) > L.road.halfLength - 5 : c.t < -5 || c.t > L.length + 5;
      if (out || p.distanceTo(cam) > 1600) {
        c.mesh.removeFromParent();
        this.cars.splice(i, 1);
      }
    }
  }
}

