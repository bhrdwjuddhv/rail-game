import * as THREE from 'three/webgpu';
import { rng, smoothstep } from '@rail/shared/util';
import { newFrame } from '@rail/shared/track/Chainage';
import type { RoadDef, Route } from '@rail/shared/track/Route';
import type { LevelCrossingView } from '../../infrastructure/LevelCrossing';
import type { TerrainField } from '../TerrainField';
import { materials } from '../../core/Materials';
import { settings } from '../../core/Settings';
import { isTouch } from '../../input/Device';
import { GeoBatch, mat } from '../../core/GeoBatch';
import { lampPool, propMaterials } from '../scenery/Props';
import { formationHalf, laneLat, type ParallelRoad, parallelRoads, pavedHalf, roadTop, SECTION, TOLL } from '../roads/Highways';
import { modelKey, VARIANTS, type VehicleModel, type VehicleType, vehicleModels } from './VehicleKit';

/**
 * Road traffic: on the highways and town streets alongside the line (Highways) and the level crossings' roads.
 *
 * Indian rules of the road, kept simple and cheap: traffic keeps left (going up the km a vehicle takes the
 * carriageway at smaller offsets, and its left lane); each type at its own speed (trucks 50-70 km/h, buses 60-80,
 * cars 80-110, tractors 25-35...), keeping its distance; on a 4-lane road faster ones overtake in the right lane
 * and move back; everyone slows for junctions, speed breakers and a market, queues at a toll plaza and stops at the
 * booth till its barrier lifts; now and then one turns through a median gap, or pulls in at a dhaba, a fuel pump or
 * a tea stall for a while; on a state highway cattle wander across and traffic waits. Vehicles at level crossings
 * queue at closed barriers. Horns: overtaking, stuck behind something slow, waiting.
 *
 * Density by road (busy highways, quieter state roads), time of day (trucks run all night, the rest thins out) and
 * the traffic setting, within a budget per quality preset; only within ~1.5 km of the camera (vehicles leave and
 * join out at the edges). Drawn in four batches whatever the count - bodies, painted panels (the vehicle pack:
 * truck art, bus liveries, auto colours), lamps (lit at night), headlight pools - each vehicle swapping to a plain
 * far body beyond 260 m; toll barrier arms are one instanced draw.
 */
const WINDOW = 1200;
const BUDGET: Record<string, number> = { low: 40, medium: 90, high: 150, ultra: 210 };
/** vehicles per km in each direction */
const DENSITY = { nh: 11, sh: 4, street: 5, lc: 2 };
/** the traffic setting's multipliers (low, medium, high, very high) */
const LEVEL = [0.55, 1, 1.4, 1.8];
const KMH = 1 / 3.6;

type Path = { kind: 'road'; road: ParallelRoad; id: string } | { kind: 'lc'; rd: RoadDef; lc?: LevelCrossingView; id: string };
interface Veh {
  m: VehicleModel; path: Path; dir: 1 | -1;
  /** a road's: m along the line (km x 1000); a level crossing road's: m along it from the crossing */
  s: number;
  /** 0 the left lane, 1 the right (4 lanes); laneTo: where it is moving to */
  lane: number; laneTo: number; laneSince: number;
  speed: number; want: number; tint: THREE.Color;
  state: 'drive' | 'toll' | 'site' | 'uturn' | 'cross';
  timer: number; paid: number[]; booth: number;
  site?: { s: number; lat: number; w: number; phase: 0 | 1 | 2 };
  uturn?: number; ut: number;
  /** a cow's way across: lateral (m from the road's centre) now and where it goes */
  cross?: { lat: number; to: number };
  /** keeps to the shoulder this far out (m) */
  edge: number;
  stuck: number; honk: number;
  slot: number; far: boolean;
  /** this frame: position and lateral offset (m from the road's centre) */
  lat: number; x: number; y: number; z: number; yaw: number;
}
type Mix = [VehicleType, number][];
const MIX: Record<string, Mix> = {
  nh: [['truck', 22], ['tanker', 5], ['container', 7], ['carcarrier', 2], ['hatch', 10], ['sedan', 8], ['suv', 7], ['taxi', 4], ['bus', 6], ['sleeper', 4], ['tempo', 7], ['bike', 10], ['tractor', 3], ['auto', 2], ['cart', 1], ['cycle', 2]],
  sh: [['truck', 18], ['tanker', 3], ['hatch', 10], ['sedan', 6], ['suv', 6], ['taxi', 3], ['bus', 10], ['tempo', 8], ['bike', 15], ['tractor', 8], ['auto', 6], ['cart', 3], ['cycle', 4]],
  street: [['auto', 22], ['bike', 22], ['hatch', 10], ['sedan', 5], ['taxi', 4], ['rickshaw', 9], ['tempo', 8], ['tractor', 4], ['cart', 3], ['cycle', 8], ['bus', 5]],
};
const HEAVY = new Set<VehicleType>(['truck', 'tanker', 'container', 'carcarrier']);
const SLOW_BY_NIGHT = new Set<VehicleType>(['bike', 'auto', 'cart', 'cycle', 'rickshaw', 'tractor']);
const TINTS = ['#c0392b', '#ecf0f1', '#2c3e50', '#7f8c8d', '#2980b9', '#f39c12', '#16a085', '#8e44ad', '#d9d9d9', '#b5442f'];

export class Traffic {
  readonly group = new THREE.Group();
  onHonk?: (pos: THREE.Vector3) => void;
  private vehicles: Veh[] = [];
  private paths: Path[] = [];
  private r = rng(77);
  private f = newFrame();
  private free: number[] = [];
  private body: THREE.BatchedMesh;
  private deco: THREE.BatchedMesh;
  private lamps: THREE.BatchedMesh;
  private pools: THREE.BatchedMesh;
  private lampMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  private poolMat: THREE.MeshBasicMaterial;
  private gid = new Map<string, { body: number; far: number; deco: number; lamps: number }>();
  private poolGid: number;
  private arms: THREE.InstancedMesh;
  /** toll barriers: open (0..1) per plaza, side and lane */
  private open = new Map<string, number>();
  private camS = new Map<string, number>();
  private cowTimer = new Map<string, number>();
  private lastCam = new THREE.Vector3(1e9, 0, 0);
  private fill = 0;
  private clock = 0;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v3 = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);

  constructor(private route: Route, private field: TerrainField, lcs: LevelCrossingView[]) {
    for (const road of parallelRoads(route)) this.paths.push({ kind: 'road', road, id: road.id });
    for (const rd of route.roads) if (rd.kind === 'lc') this.paths.push({ kind: 'lc', rd, lc: lcs.find(l => l.road === rd), id: rd.id });

    // the batches: every model's geometries once; a slot per vehicle the largest budget allows
    const ms = [...vehicleModels().values()];
    const N = Math.max(...Object.values(BUDGET));
    const sizes = (geos: (THREE.BufferGeometry | null)[]) => geos.reduce((a, g) => g ? [a[0] + g.attributes.position.count, a[1] + (g.index?.count ?? 0)] : a, [0, 0]);
    const poolGeo = new THREE.PlaneGeometry(5, 13).rotateX(-Math.PI / 2).translate(9, 0.05, 0);
    poolGeo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(poolGeo.attributes.position.count * 3).fill(1), 3));
    const mk = (geos: (THREE.BufferGeometry | null)[], m: THREE.Material) => {
      const [v, i] = sizes(geos);
      const bm = new THREE.BatchedMesh(N, v, i, m);
      bm.sortObjects = false;
      bm.perObjectFrustumCulled = true;
      bm.frustumCulled = false;
      return bm;
    };
    this.body = mk(ms.flatMap(m => [m.body, m.far]), materials().std);
    this.deco = mk(ms.map(m => m.deco), propMaterials()['life-vehicle']);
    this.lamps = mk(ms.map(m => m.lamps), this.lampMat);
    this.poolMat = new THREE.MeshBasicMaterial({ map: lampPool.map, color: 0xfff0d2, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    this.pools = mk([poolGeo], this.poolMat);
    for (const m of ms) this.gid.set(modelKey(m.type, m.variant), {
      body: this.body.addGeometry(m.body), far: this.body.addGeometry(m.far),
      deco: m.deco ? this.deco.addGeometry(m.deco) : -1, lamps: m.lamps ? this.lamps.addGeometry(m.lamps) : -1,
    });
    this.poolGid = this.pools.addGeometry(poolGeo);
    // (slots: an instance in each batch, hidden till a vehicle takes it; geometry swapped as it does)
    const any = this.gid.values().next().value!, anyDeco = [...this.gid.values()].find(g => g.deco >= 0)?.deco ?? -1, anyLamp = [...this.gid.values()].find(g => g.lamps >= 0)!.lamps;
    for (let i = 0; i < N; i++) {
      this.body.addInstance(any.body); this.body.setVisibleAt(i, false);
      if (anyDeco >= 0) { this.deco.addInstance(anyDeco); this.deco.setVisibleAt(i, false); }
      this.lamps.addInstance(anyLamp); this.lamps.setVisibleAt(i, false);
      this.pools.addInstance(this.poolGid); this.pools.setVisibleAt(i, false);
      this.free.push(N - 1 - i);
    }
    this.body.castShadow = true; this.body.receiveShadow = true;
    this.deco.receiveShadow = true;
    this.group.add(this.body, this.deco, this.lamps, this.pools);
    // toll barrier arms (red and white), pivoting up at the post
    const ab = new GeoBatch();
    for (let k = 0; k < 8; k++) ab.box(0.4, 0.08, 0.08, mat(0.2 + k * 0.4, 0, 0), k % 2 ? '#f4f4f0' : '#d61f1f');
    this.arms = new THREE.InstancedMesh(ab.geometry('std')!, materials().std, 64);
    this.arms.count = 0;
    this.arms.frustumCulled = false;
    this.group.add(this.arms);
  }

  // ------------------------------------------------------------------ geometry along the paths
  private road(v: Veh) { return (v.path as { road: ParallelRoad }).road; }

  /** a road vehicle's lateral place (m right of the line) at s, as things stand */
  private latAt(v: Veh, s: number) {
    const r = this.road(v), k = r.kind, km = s / 1000, c = r.offsetAt(Math.min(r.toKm, Math.max(r.fromKm, km)));
    const nl = SECTION[k].lanes;
    let lat = laneLat(k, v.dir, 0) + (nl > 1 ? (laneLat(k, v.dir, nl - 1) - laneLat(k, v.dir, 0)) * v.lane : 0) - v.dir * v.edge;
    // a toll plaza: into its booth lane
    for (const t of r.tolls) {
      const d = Math.abs(s - t * 1000);
      if (d > TOLL.flat + TOLL.taper) continue;
      const booth = -v.dir * (SECTION.nh.median / 2 + TOLL.island + v.booth * (TOLL.lane + TOLL.island) + TOLL.lane / 2);
      lat += (booth - lat) * (1 - smoothstep(TOLL.flat * 0.6, TOLL.flat + TOLL.taper, d));
    }
    if (v.site) lat += (v.site.lat - lat) * smoothstep(0, 1, v.site.w);
    if (v.cross) lat = v.cross.lat;
    return c + lat;
  }

  private place(v: Veh) {
    const f = this.f;
    if (v.path.kind === 'lc') {
      const rd = v.path.rd, la = v.dir * -1.8, t = v.s;
      v.x = rd.ax + rd.dx * t - rd.dz * la; v.z = rd.az + rd.dz * t + rd.dx * la;
      v.y = this.field.lcRoadElevation(rd, t);
      v.yaw = Math.atan2(-rd.dz * v.dir, rd.dx * v.dir);
      return;
    }
    if (v.state === 'uturn') {
      // round through the median gap: from the right lane of one carriageway to the right lane of the other
      const r = this.road(v), g = v.uturn! * 1000, R = 5;
      const lat = (u: number) => r.offsetAt(g / 1000) - v.dir * 3.75 * Math.cos(Math.PI * u);
      const pos = (u: number) => { this.route.alignment.sampleOffset(g + v.dir * R * Math.sin(Math.PI * u), lat(u), f); return [f.x, f.z]; };
      const [x0, z0] = pos(v.ut), [x1, z1] = pos(Math.min(1, v.ut + 0.02));
      v.x = x0; v.z = z0; v.y = roadTop(this.route, g / 1000); v.lat = lat(v.ut);
      v.yaw = Math.atan2(-(z1 - z0), x1 - x0) || v.yaw;
      return;
    }
    const lat = this.latAt(v, v.s);
    this.route.alignment.sampleOffset(v.s, lat, f);
    v.x = f.x; v.z = f.z; v.lat = lat;
    v.y = roadTop(this.route, v.s / 1000);
    if (v.state === 'cross') { v.yaw = -f.heading + (v.cross!.to > v.cross!.lat ? -Math.PI / 2 : Math.PI / 2); return; }
    const ahead = v.s + v.dir * 2.5, lat2 = this.latAt(v, ahead);
    this.route.alignment.sampleOffset(ahead, lat2, f);
    v.yaw = Math.atan2(-(f.z - v.z), f.x - v.x);
  }

  // ------------------------------------------------------------------ spawning
  private pick(mix: Mix, night: number): VehicleType {
    const w = mix.map(([t, n]) => n * (night > 0.5 ? (HEAVY.has(t) ? 2.2 : SLOW_BY_NIGHT.has(t) ? 0.25 : 0.6) : 1));
    let x = this.r() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < mix.length; i++) if ((x -= w[i]) <= 0) return mix[i][0];
    return mix[0][0];
  }

  private spawn(path: Path, dir: 1 | -1, s: number, night: number) {
    if (!this.free.length) return;
    const kind = path.kind === 'lc' ? 'street' : path.road.kind;
    const type = this.pick(MIX[kind], night);
    const variant = Math.floor(this.r() * VARIANTS[type]);
    const m = vehicleModels().get(modelKey(type, variant))!;
    const cap = kind === 'street' ? 32 : kind === 'sh' ? 75 : 200;
    const kmph = Math.min(cap, m.kmph[0] + this.r() * (m.kmph[1] - m.kmph[0]));
    const nl = path.kind === 'road' ? SECTION[path.road.kind].lanes : 1;
    const v: Veh = {
      m, path, dir, s, lane: 0, laneTo: 0, laneSince: 0, speed: kmph * KMH * 0.8, want: kmph * KMH, tint: new THREE.Color(m.tinted ? TINTS[Math.floor(this.r() * TINTS.length)] : '#ffffff'),
      state: 'drive', timer: 0, paid: [], booth: 0, ut: 0, edge: m.edge && nl > 1 ? 1.6 : m.edge ? 0.6 : 0, stuck: 0, honk: 5 + this.r() * 20,
      slot: this.free.pop()!, far: false, lat: 0, x: 0, y: 0, z: 0, yaw: 0,
    };
    // a faster car may join in the right lane; some head for a U-turn or a stop by the road
    if (nl > 1 && !m.edge && m.kmph[1] > 85 && this.r() < 0.3) v.lane = v.laneTo = 1;
    if (path.kind === 'road') {
      const r = path.road, ahead = (km: number) => (km * 1000 - s) * dir > 300;
      // (a toll booth lane: the slow ones keep to the outer booths)
      v.booth = HEAVY.has(type) || m.edge ? 2 + Math.floor(this.r() * 2) : Math.floor(this.r() * 3);
      if (r.gaps.length && this.r() < 0.03) v.uturn = r.gaps.find(g => ahead(g));
      const stopWants = HEAVY.has(type) ? ['dhaba', 'repair', 'tea'] : ['hatch', 'sedan', 'suv', 'taxi', 'bike'].includes(type) ? ['petrol', 'tea'] : [];
      if (stopWants.length && this.r() < 0.15) {
        const site = r.sites.filter(x => stopWants.includes(x.kind) && x.side === -dir && ahead(x.km)).sort((a, b) => (a.km - b.km) * dir)[0];
        if (site) {
          const pad = site.kind === 'tea' ? 1.5 : 7;
          // (where it stops: out on the forecourt, or on the shoulder by a tea stall; m from the road's centre)
          v.site = { s: site.km * 1000 - dir * 6, lat: -dir * (pavedHalf(r.kind) + pad), w: 0, phase: 0 };
        }
      }
    }
    this.vehicles.push(v);
  }

  private release(i: number) {
    const v = this.vehicles[i];
    this.body.setVisibleAt(v.slot, false); if (this.deco.instanceCount) this.deco.setVisibleAt(v.slot, false);
    this.lamps.setVisibleAt(v.slot, false); this.pools.setVisibleAt(v.slot, false);
    this.free.push(v.slot);
    this.vehicles.splice(i, 1);
  }

  /** where along a path the camera is (m), and how far off it */
  private camOn(path: Path, cam: THREE.Vector3): [number, number] {
    if (path.kind === 'lc') { const rd = path.rd, px = cam.x - rd.ax, pz = cam.z - rd.az; return [px * rd.dx + pz * rd.dz, Math.abs(px * -rd.dz + pz * rd.dx)]; }
    const nt = this.field.nearest(cam.x, cam.z, 1200);
    const km = nt ? nt.km : this.field.kmAt(cam.x, cam.z);
    const off = nt ? Math.abs(nt.d - path.road.offsetAt(Math.min(path.road.toKm, Math.max(path.road.fromKm, km)))) : 2000;
    return [km * 1000, off];
  }

  // ------------------------------------------------------------------ the frame
  update(dt: number, cam: THREE.Vector3, hours = 12, night = 0) {
    dt = Math.min(dt, 0.1);
    this.clock += dt;
    // the camera jumped (start, teleport): fill the roads round it at once
    if (cam.distanceTo(this.lastCam) > 600) this.fill = 2;
    this.lastCam.copy(cam);
    const q = settings.get().quality, budget = Math.round((BUDGET[q] ?? 70) * (isTouch ? 0.6 : 1));
    const tod = hours < 5 ? 0.3 : hours < 7 ? 0.6 : hours < 11 ? 1.2 : hours < 17 ? 1 : hours < 21 ? 1.25 : 0.6;
    const level = LEVEL[Math.max(0, Math.min(3, Math.round(settings.get().traffic ?? 1)))];

    // ---- how many where: each path's stretch near the camera
    const wants: { path: Path; dir: 1 | -1; lo: number; hi: number; n: number; cs: number }[] = [];
    for (const p of this.paths) {
      const [cs, off] = this.camOn(p, cam);
      const L0 = p.kind === 'lc' ? -p.rd.halfLength : p.road.fromKm * 1000, L1 = p.kind === 'lc' ? p.rd.halfLength : p.road.toKm * 1000;
      const lo = Math.max(L0, cs - WINDOW), hi = Math.min(L1, cs + WINDOW);
      // (out of reach: its vehicles go - see below)
      if (off > WINDOW || hi - lo < 50) { this.camS.delete(p.id); continue; }
      this.camS.set(p.id, cs);
      const dens = DENSITY[p.kind === 'lc' ? 'lc' : p.road.kind] * tod * level * (1 - off / (WINDOW * 1.4));
      for (const dir of [1, -1] as const) wants.push({ path: p, dir, lo, hi, n: dens * (hi - lo) / 1000, cs });
    }
    const total = wants.reduce((a, w) => a + w.n, 0), scale = total > budget ? budget / total : 1;
    for (const w of wants) {
      const have = this.vehicles.filter(v => v.path === w.path && v.dir === w.dir && v.state !== 'cross').length;
      const want = Math.round(w.n * scale);
      if (have >= want || !this.free.length) continue;
      // (filling: anywhere along it; else where traffic comes from, out of the near view)
      let s: number;
      if (this.fill > 0) s = w.lo + this.r() * (w.hi - w.lo);
      else {
        const from = w.dir > 0 ? w.lo : w.hi;
        if (Math.abs(from - w.cs) < 700 && !(w.path.kind === 'road' && Math.abs(from - (w.dir > 0 ? w.path.road.fromKm : w.path.road.toKm) * 1000) < 1)) continue;
        if (this.r() > dt * 1.5) continue;
        s = from;
      }
      if (this.vehicles.some(o => o.path === w.path && o.dir === w.dir && Math.abs(o.s - s) < 30)) continue;
      this.spawn(w.path, w.dir, s, night);
    }
    this.fill = Math.max(0, this.fill - dt);
    this.cattle(dt);

    // ---- drive
    for (const v of this.vehicles) this.place(v);
    for (const v of this.vehicles) this.drive(v, dt);

    // ---- leave: off the stretch near the camera, or off the end of its road
    for (let i = this.vehicles.length - 1; i >= 0; i--) {
      const v = this.vehicles[i], p = v.path;
      const L0 = p.kind === 'lc' ? -p.rd.halfLength : p.road.fromKm * 1000, L1 = p.kind === 'lc' ? p.rd.halfLength : p.road.toKm * 1000;
      const cs = this.camS.get(p.id);
      if (cs === undefined || v.s < L0 - 2 || v.s > L1 + 2 || Math.abs(v.s - cs) > WINDOW + 250 || (v.state === 'cross' && v.timer > 60)) this.release(i);
    }

    this.draw(cam, night);
    this.drawArms();
  }

  private drive(v: Veh, dt: number) {
    if (v.state === 'cross') {
      // a cow ambling across the road
      v.timer += dt;
      const d = v.cross!.to - v.cross!.lat;
      if (Math.abs(d) > 0.05) v.cross!.lat += Math.sign(d) * Math.min(Math.abs(d), 0.7 * dt);
      else v.timer = 999;
      return;
    }
    if (v.state === 'uturn') {
      v.ut += dt / 6;
      if (v.ut >= 1) { v.dir = -v.dir as 1 | -1; v.s = v.uturn! * 1000; v.uturn = undefined; v.state = 'drive'; v.lane = v.laneTo = 1; v.laneSince = this.clock; v.speed = 4; }
      return;
    }
    const p = v.path;
    let target = v.want;
    const len = v.m.length;
    // ---- the road's own slow spots
    if (p.kind === 'road') {
      const r = p.road, k = r.kind;
      const ahead = (s: number) => (s - v.s) * v.dir;
      for (const j of r.junctions) {
        const d = ahead(j * 1000);
        if (k === 'nh' && d > -60 && d < 180) target = Math.min(target, 60 * KMH);
        if (k === 'sh') for (const bk of [j * 1000 - v.dir * 45, j * 1000 + v.dir * 45]) { const db = ahead(bk); if (db > -3 && db < 80) target = Math.min(target, Math.sqrt((12 * KMH) ** 2 + 3 * Math.max(0, db - 4))); }
      }
      for (const x of r.sites) if (x.kind === 'market' && Math.abs(x.km * 1000 - v.s) < 220) target = Math.min(target, 40 * KMH);
      // toll: queue and stop at the booth; the barrier lifts, then on
      for (const t of r.tolls) {
        if (v.paid.includes(t)) continue;
        const stop = t * 1000 + v.dir * (1.0 - len / 2), d = ahead(stop);
        if (d < -5) { v.paid.push(t); continue; }
        if (d < 300) target = Math.min(target, Math.sqrt(2 * 1.8 * Math.max(0, d)));
        if (d < 0.8 && v.speed < 0.4) {
          v.state = 'toll'; v.timer += dt;
          if (v.timer > 1.6) this.open.set(`${t}:${v.dir}:${v.booth}`, this.clock + 3.5);
          if (v.timer > 2.8 + (HEAVY.has(v.m.type) ? 2.5 : 0)) { v.paid.push(t); v.state = 'drive'; v.timer = 0; if (this.r() < 0.05) this.honkAt(v); }
          else target = 0;
        }
      }
      // a U-turn: over to the right lane, slow, round through the gap
      if (v.uturn !== undefined) {
        const d = ahead(v.uturn * 1000);
        if (d < 200) { v.laneTo = 1; target = Math.min(target, Math.max(4, d * 0.12)); }
        if (d < 1.5 && v.lane > 0.9) { v.state = 'uturn'; v.ut = 0; return; }
      }
      // a stop by the road: in, a while parked, out again when the lane is clear
      if (v.site) {
        const st = v.site, d = ahead(st.s);
        if (st.phase === 0 && d < 140) { v.laneTo = 0; target = Math.min(target, Math.max(1.2, d * 0.2)); if (d < 30) st.w = Math.min(1, st.w + dt / 4); if (d < 1) { st.phase = 1; v.timer = 15 + this.r() * 40; } }
        if (st.phase === 1) { target = 0; v.speed = 0; v.timer -= dt; if (v.timer < 0 && this.clear(v, 0, 45, 15)) st.phase = 2; }
        if (st.phase === 2) { target = Math.min(target, 8); st.w = Math.max(0, st.w - dt / 5); if (st.w <= 0) v.site = undefined; }
      }
      if (k === 'street') target = Math.min(target, 32 * KMH);
    } else {
      // a level crossing: wait at closed barriers (and for an approaching train at an unmanned one)
      const L = p.lc;
      if (L && (L.closing || L.closed > 0.05)) {
        const stopT = -v.dir * (L.gateT + 3), d = (stopT - v.s) * v.dir;
        if (d > -1) target = Math.min(target, Math.max(0, (d - 1) * 0.8));
      }
    }
    // ---- the vehicle in front (in its lane), and cattle on the road
    let gap = Infinity, lead: Veh | null = null;
    for (const o of this.vehicles) {
      if (o === v || o.path !== v.path) continue;
      if (o.state !== 'cross' && o.dir !== v.dir && o.state !== 'uturn') continue;
      if (Math.abs(o.lat - v.lat) > (o.state === 'cross' ? 2.4 : 2.2)) continue;
      const d = (o.s - v.s) * v.dir - (o.m.length + len) / 2;
      if (d > -1 && d < gap) { gap = d; lead = o; }
    }
    if (lead) {
      if (lead.state === 'cross') target = Math.min(target, Math.sqrt(2 * 3 * Math.max(0, gap - 6)));
      else if (gap < v.speed * 1.8 + 8) target = Math.min(target, gap < 4 ? 0 : lead.speed * Math.min(1, (gap - 4) / 10));
    }
    // ---- overtaking on a 4-lane road: out to the right lane past something slower, back to the left after
    const four = p.kind === 'road' && SECTION[p.road.kind].lanes > 1;
    if (four && v.state === 'drive' && !v.site && v.uturn === undefined && !v.m.edge) {
      if (v.laneTo === 0 && lead && lead.state !== 'cross' && gap < 45 && lead.speed < v.want - 2.5 && this.clear(v, 1, 30, 25)) {
        v.laneTo = 1; v.laneSince = this.clock;
        if (this.r() < 0.3) this.honkAt(v);
      } else if (v.laneTo === 1 && this.clock - v.laneSince > 4 && this.clear(v, 0, 35, 12)) v.laneTo = 0;
    }
    if (v.lane !== v.laneTo) v.lane += Math.sign(v.laneTo - v.lane) * Math.min(Math.abs(v.laneTo - v.lane), dt / 2.2);
    // stuck behind something slow: the horn
    v.stuck = lead && lead.speed < v.want * 0.5 && gap < 20 ? v.stuck + dt : 0;
    if (v.stuck > 6 && (v.honk -= dt) < 0) { v.honk = 8 + this.r() * 12; this.honkAt(v); }
    if (p.kind === 'lc' && v.speed < 0.2 && (v.honk -= dt) < 0) { v.honk = 6 + this.r() * 18; this.honkAt(v); }
    // ---- speed
    v.speed += Math.max(-6 * dt, Math.min(v.m.accel * dt, target - v.speed));
    if (v.speed < 0) v.speed = 0;
    v.s += v.speed * dt * v.dir;
    if (v.state === 'toll' && target > 0) v.state = 'drive';
  }

  /** lane (0 left, 1 right) clear behind (m) and ahead (m) of v */
  private clear(v: Veh, lane: number, ahead: number, behind: number) {
    for (const o of this.vehicles) {
      if (o === v || o.path !== v.path || o.dir !== v.dir || o.state === 'cross') continue;
      if (Math.abs(o.lane - lane) > 0.5 && Math.abs(o.laneTo - lane) > 0.5) continue;
      const d = (o.s - v.s) * v.dir;
      if (d > -behind && d < ahead) return false;
    }
    return true;
  }

  private honkAt(v: Veh) { this.onHonk?.(new THREE.Vector3(v.x, v.y + 1, v.z)); }

  /** cattle crossing a state highway now and then, near the camera (traffic waits for them) */
  private cattle(dt: number) {
    for (const p of this.paths) {
      if (p.kind !== 'road' || p.road.kind !== 'sh') continue;
      const cs = this.camS.get(p.id);
      if (cs === undefined) continue;
      const t = (this.cowTimer.get(p.id) ?? 20 + this.r() * 40) - dt;
      this.cowTimer.set(p.id, t);
      if (t > 0 || !this.free.length) continue;
      this.cowTimer.set(p.id, 60 + this.r() * 60);
      const r = p.road, s = cs + (this.r() < 0.5 ? -1 : 1) * (150 + this.r() * 250);
      if (s < r.fromKm * 1000 + 300 || s > r.toKm * 1000 - 300) continue;
      const fh = formationHalf(r.kind) + 2, from = this.r() < 0.5 ? -fh : fh;
      for (let i = 0; i < 2 + Math.floor(this.r() * 2); i++) {
        this.spawnCow(p, s + i * 3.5, from - Math.sign(from) * i * 1.5, -from);
      }
    }
  }

  private spawnCow(path: Path, s: number, lat: number, to: number) {
    if (!this.free.length) return;
    const m = vehicleModels().get(modelKey('cow', Math.floor(this.r() * VARIANTS.cow)))!;
    this.vehicles.push({ m, path, dir: 1, s, lane: 0, laneTo: 0, laneSince: 0, speed: 0, want: 0, tint: new THREE.Color('#ffffff'), state: 'cross', timer: 0, paid: [], booth: 0, ut: 0,
      cross: { lat, to }, edge: 0, stuck: 0, honk: 0, slot: this.free.pop()!, far: false, lat, x: 0, y: 0, z: 0, yaw: 0 });
  }

  // ------------------------------------------------------------------ drawing
  private draw(cam: THREE.Vector3, night: number) {
    this.lampMat.color.setScalar(night > 0.25 ? 1 + 1.6 * night : 0.55);
    this.poolMat.opacity = 0.18 * night;
    const pools = night > 0.25;
    for (const v of this.vehicles) {
      const g = this.gid.get(modelKey(v.m.type, v.m.variant))!;
      const d = Math.hypot(v.x - cam.x, v.z - cam.z), far = d > 260;
      // (a vehicle leaving at the far end of a road that ends in the fields shrinks away into the distance)
      let sc = 1;
      if (v.path.kind === 'road') { const r = v.path.road, e = Math.min(v.s - r.fromKm * 1000, r.toKm * 1000 - v.s); sc = Math.max(0.01, Math.min(1, e / 25)); }
      this.m4.compose(this.v3.set(v.x, v.y, v.z), this.q.setFromEuler(this.e.set(0, v.yaw, 0)), this.one.setScalar(sc));
      this.body.setGeometryIdAt(v.slot, far ? g.far : g.body);
      this.body.setMatrixAt(v.slot, this.m4); this.body.setColorAt(v.slot, v.tint); this.body.setVisibleAt(v.slot, true);
      if (g.deco >= 0 && !far) { this.deco.setGeometryIdAt(v.slot, g.deco); this.deco.setMatrixAt(v.slot, this.m4); this.deco.setVisibleAt(v.slot, true); }
      else if (this.deco.instanceCount) this.deco.setVisibleAt(v.slot, false);
      if (g.lamps >= 0) { this.lamps.setGeometryIdAt(v.slot, g.lamps); this.lamps.setMatrixAt(v.slot, this.m4); this.lamps.setVisibleAt(v.slot, true); }
      else this.lamps.setVisibleAt(v.slot, false);
      const lit = pools && v.m.pool && d < 450 && v.state !== 'toll';
      if (lit) this.pools.setMatrixAt(v.slot, this.m4);
      this.pools.setVisibleAt(v.slot, lit);
    }
  }

  /** the toll barriers near the camera: down, or lifting for the vehicle at the booth */
  private drawArms() {
    let n = 0;
    const f = this.f;
    for (const p of this.paths) {
      if (p.kind !== 'road' || !p.road.tolls.length || !this.camS.has(p.id)) continue;
      const r = p.road, cs = this.camS.get(p.id)!;
      for (const t of r.tolls) {
        if (Math.abs(t * 1000 - cs) > WINDOW) continue;
        for (const dir of [1, -1] as const) for (let lane = 0; lane < TOLL.lanes && n < 64; lane++) {
          const key = `${t}:${dir}:${lane}`, until = this.open.get(key) ?? 0;
          const o = Math.max(0, Math.min(1, (this.open.get(key + ':a') ?? 0) + (this.clock < until ? 0.05 : -0.05)));
          this.open.set(key + ':a', o);
          // the arm pivots on the island beyond its lane and reaches back across it
          const inner = SECTION.nh.median / 2, isl = (i: number) => inner + TOLL.island / 2 + i * (TOLL.lane + TOLL.island);
          const pivot = -dir * isl(lane + 1), lc = -dir * (inner + TOLL.island + lane * (TOLL.lane + TOLL.island) + TOLL.lane / 2), s = t * 1000 + dir * 1.5, km = s / 1000;
          this.route.alignment.sampleOffset(s, r.offsetAt(km) + pivot, f);
          const x = f.x, z = f.z, h = f.heading, toward = Math.sign(lc - pivot);
          const ax = -Math.sin(h) * toward, az = Math.cos(h) * toward;
          this.q.setFromEuler(this.e.set(0, Math.atan2(-az, ax), o * 1.35, 'YXZ'));
          this.arms.setMatrixAt(n++, this.m4.compose(this.v3.set(x, roadTop(this.route, km) + 1.0, z), this.q, this.one.setScalar(1)));
        }
      }
    }
    this.arms.count = n;
    this.arms.instanceMatrix.needsUpdate = true;
  }
}
