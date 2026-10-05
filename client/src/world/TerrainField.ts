import { clamp, fbm, hash2, lerp, ridged, smoothstep } from '@rail/shared/util';
import { newFrame } from '@rail/shared/track/Chainage';
import type { RegionData, RiverDef, RoadDef, Route } from '@rail/shared/track/Route';

/**
 * The ground height function, shared by the terrain worker and the main
 * thread. Pure TS (no three.js). Built in layers:
 *   base grid (track elevation + ghat side slopes + tunnel hills, 100 m cells)
 *   + region noise (small near the line, mountains far away)
 *   - river valleys, ponds
 *   -> track formation carved as embankment or cutting (1 : 1.5 slopes)
 *   -> road beds flattened
 */
export interface NearestTrack { km: number; d: number; dist: number; heading: number }
export interface GroundSample { h: number; hole: boolean; nt: NearestTrack | null; river: number; road: number; pond: number; natural: number }
export interface Pond { x: number; z: number; r: number; level: number }

const SAMPLE_M = 25;
const CELL = 250;
const BASE_CELL = 100;
const NEAR_MAX = 250;

export class TerrainField {
  private sx: Float64Array; private sz: Float64Array; private sh: Float64Array;
  private n: number;
  private cells = new Map<number, number[]>();
  private sideSign: Float32Array;
  private bx0 = 0; private bz0 = 0; private bnx = 0; private bnz = 0;
  private base!: Float32Array; private baseKm!: Float32Array;
  private plains: RegionData; private ghats: RegionData;
  private pondCache = new Map<number, Pond | null>();
  readonly grounds: { x: number; z: number; r: number; heading: number }[] = [];
  private nt: NearestTrack = { km: 0, d: 0, dist: 0, heading: 0 };

  constructor(readonly route: Route) {
    const a = route.alignment;
    this.n = Math.floor(a.length / SAMPLE_M) + 1;
    this.sx = new Float64Array(this.n); this.sz = new Float64Array(this.n); this.sh = new Float64Array(this.n);
    const f = newFrame();
    for (let i = 0; i < this.n; i++) {
      a.sample(Math.min(i * SAMPLE_M, a.length), f);
      this.sx[i] = f.x; this.sz[i] = f.z; this.sh[i] = f.heading;
      const key = this.cellKey(Math.floor(f.x / CELL), Math.floor(f.z / CELL));
      let list = this.cells.get(key);
      if (!list) this.cells.set(key, (list = []));
      list.push(i);
    }
    // smoothed curvature sign: ghat hillside on the inside of curves
    this.sideSign = new Float32Array(this.n);
    const W = 16; // +-400 m
    for (let i = 0; i < this.n; i++) {
      let k = 0;
      for (let j = Math.max(0, i - W); j <= Math.min(this.n - 1, i + W); j++) k += a.curvature[Math.min(a.curvature.length - 1, j * SAMPLE_M)];
      this.sideSign[i] = Math.tanh((k / (2 * W + 1)) * 1500);
    }
    const regs = Object.values(route.regions);
    this.plains = regs.find(r => r.sideSlope === 0) ?? regs[0];
    this.ghats = regs.find(r => r.sideSlope > 0) ?? regs[0];
    for (const z of route.data.scenery) {
      if (z.zone !== 'colony') continue;
      const km = (z.fromKm + z.toKm) / 2;
      a.sample(km * 1000, f);
      const off = -(Math.sign(z.roadOffset ?? 1) || 1) * 150;
      this.grounds.push({ x: f.x - Math.sin(f.heading) * off, z: f.z + Math.cos(f.heading) * off, r: 55, heading: f.heading });
    }
    this.buildBase();
  }

  private cellKey(cx: number, cz: number) { return (cx + 4096) * 8192 + (cz + 4096); }

  /** Nearest point on the centreline within maxD (signed lateral d, + = right). */
  nearest(x: number, z: number, maxD = NEAR_MAX): NearestTrack | null {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    const reach = Math.ceil(maxD / CELL);
    let best = -1, bd = maxD * maxD;
    for (let i = -reach; i <= reach; i++) for (let j = -reach; j <= reach; j++) {
      const list = this.cells.get(this.cellKey(cx + i, cz + j));
      if (!list) continue;
      for (const k of list) {
        const dx = this.sx[k] - x, dz = this.sz[k] - z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bd) { bd = d2; best = k; }
      }
    }
    if (best < 0) return null;
    // refine on the two adjacent chords
    let rkm = 0, rd = Infinity, rs = 0, rh = 0;
    for (const k0 of [best - 1, best]) {
      const k1 = k0 + 1;
      if (k0 < 0 || k1 >= this.n) continue;
      const ax = this.sx[k0], az = this.sz[k0];
      const dx = this.sx[k1] - ax, dz = this.sz[k1] - az;
      const L2 = dx * dx + dz * dz;
      const t = clamp(((x - ax) * dx + (z - az) * dz) / L2, 0, 1);
      const px = ax + dx * t, pz = az + dz * t;
      const dist = Math.hypot(x - px, z - pz);
      if (dist < rd) {
        rd = dist;
        rkm = ((k0 + t) * SAMPLE_M) / 1000;
        const L = Math.sqrt(L2);
        rs = ((x - px) * -dz + (z - pz) * dx) / L >= 0 ? 1 : -1;
        rh = this.sh[k0] + (this.sh[k1] - this.sh[k0]) * t;
      }
    }
    if (rd > maxD) return null;
    const o = this.nt;
    o.km = Math.min(rkm, this.route.lengthKm); o.d = rd * rs; o.dist = rd; o.heading = rh;
    return o;
  }

  private nearestAny(x: number, z: number) {
    let best = 0, bd = Infinity;
    for (let k = 0; k < this.n; k += 4) {
      const dx = this.sx[k] - x, dz = this.sz[k] - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; best = k; }
    }
    for (let k = Math.max(0, best - 4); k <= Math.min(this.n - 1, best + 4); k++) {
      const dx = this.sx[k] - x, dz = this.sz[k] - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; best = k; }
    }
    const h = this.sh[best];
    const d = (x - this.sx[best]) * -Math.sin(h) + (z - this.sz[best]) * Math.cos(h);
    return { k: best, d };
  }

  private buildBase() {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < this.n; i++) {
      minX = Math.min(minX, this.sx[i]); maxX = Math.max(maxX, this.sx[i]);
      minZ = Math.min(minZ, this.sz[i]); maxZ = Math.max(maxZ, this.sz[i]);
    }
    const M = 6000;
    this.bx0 = Math.floor((minX - M) / BASE_CELL) * BASE_CELL;
    this.bz0 = Math.floor((minZ - M) / BASE_CELL) * BASE_CELL;
    this.bnx = Math.ceil((maxX + M - this.bx0) / BASE_CELL) + 1;
    this.bnz = Math.ceil((maxZ + M - this.bz0) / BASE_CELL) + 1;
    const N = this.bnx * this.bnz;
    let base = new Float32Array(N);
    this.baseKm = new Float32Array(N);
    const a = this.route.alignment;
    const tunnels = this.route.tunnels;
    for (let j = 0; j < this.bnz; j++) for (let i = 0; i < this.bnx; i++) {
      const x = this.bx0 + i * BASE_CELL, z = this.bz0 + j * BASE_CELL;
      const { k, d } = this.nearestAny(x, z);
      const km = (k * SAMPLE_M) / 1000;
      const s = Math.min(a.elev.length - 1, k * SAMPLE_M);
      let h = a.elev[s];
      const g = this.route.ghatFactor(km);
      if (g > 0) h += g * this.ghats.sideSlope * clamp(d * this.sideSign[k], -650, 900);
      for (const t of tunnels) {
        const out = km < t.fromKm ? (t.fromKm - km) * 1000 : km > t.toKm ? (km - t.toKm) * 1000 : 0;
        h += 52 * (1 - smoothstep(0, 140, out)) * (1 - smoothstep(140, 420, Math.abs(d)));
      }
      base[j * this.bnx + i] = h;
      this.baseKm[j * this.bnx + i] = km;
    }
    // two box-blur passes hide Voronoi creases between track sections
    for (let pass = 0; pass < 2; pass++) {
      const out = new Float32Array(N);
      for (let j = 0; j < this.bnz; j++) for (let i = 0; i < this.bnx; i++) {
        let s = 0, c = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= this.bnx || jj >= this.bnz) continue;
          s += base[jj * this.bnx + ii]; c++;
        }
        out[j * this.bnx + i] = s / c;
      }
      base = out;
    }
    this.base = base;
  }

  private bilinear(arr: Float32Array, x: number, z: number) {
    const fx = clamp((x - this.bx0) / BASE_CELL, 0, this.bnx - 1.001);
    const fz = clamp((z - this.bz0) / BASE_CELL, 0, this.bnz - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    const a = arr[j * this.bnx + i], b = arr[j * this.bnx + i + 1];
    const c = arr[(j + 1) * this.bnx + i], d = arr[(j + 1) * this.bnx + i + 1];
    return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
  }

  /** Approximate route km for any point (for zones/biomes far from the line). */
  kmAt(x: number, z: number) {
    const fx = clamp(Math.round((x - this.bx0) / BASE_CELL), 0, this.bnx - 1);
    const fz = clamp(Math.round((z - this.bz0) / BASE_CELL), 0, this.bnz - 1);
    return this.baseKm[fz * this.bnx + fx];
  }

  ghatAt(km: number) { return this.route.ghatFactor(km); }

  /** Natural ground before the railway and roads touch it. */
  natural(x: number, z: number, nt: NearestTrack | null) {
    const km = nt ? nt.km : this.kmAt(x, z);
    const g = this.ghatAt(km);
    const near = lerp(this.plains.hillAmpNear, this.ghats.hillAmpNear, g);
    const far = lerp(this.plains.hillAmpFar, this.ghats.hillAmpFar, g);
    const freq = lerp(this.plains.hillFreq, this.ghats.hillFreq, g);
    const dist = nt ? nt.dist : NEAR_MAX;
    const amp = near + (far - near) * smoothstep(30, 240, dist);
    let h = this.bilinear(this.base, x, z);
    h += fbm(x * freq, z * freq, 5, 3) * amp;
    if (g > 0) h += g * ridged(x * freq * 0.6, z * freq * 0.6, 4, 5) * amp * 0.9 * smoothstep(60, 240, dist);
    h += fbm(x * 0.035, z * 0.035, 2, 9) * 0.5;
    return h;
  }

  riverDistance(r: RiverDef, x: number, z: number) {
    const m = r.width / 2 + 200;
    if (x < r.minX - m || x > r.maxX + m || z < r.minZ - m || z > r.maxZ + m) return Infinity;
    const P = r.points;
    let best = 0, bd = Infinity;
    for (let i = 0; i < P.length; i += 6) {
      const d = (P[i].x - x) ** 2 + (P[i].z - z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    let md = Infinity;
    for (let i = Math.max(0, best - 7); i < Math.min(P.length - 1, best + 7); i++) {
      const ax = P[i].x, az = P[i].z, dx = P[i + 1].x - ax, dz = P[i + 1].z - az;
      const t = clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz), 0, 1);
      md = Math.min(md, Math.hypot(x - ax - dx * t, z - az - dz * t));
    }
    return md;
  }

  /** Deterministic pond for a 500 m cell (or null). */
  pondFor(cx: number, cz: number): Pond | null {
    const key = this.cellKey(cx, cz);
    if (this.pondCache.has(key)) return this.pondCache.get(key)!;
    let p: Pond | null = null;
    const x = (cx + 0.2 + hash2(cx, cz, 41) * 0.6) * 500, z = (cz + 0.2 + hash2(cx, cz, 42) * 0.6) * 500;
    const km = this.kmAt(x, z);
    const zone = this.route.zoneAt(km).zone;
    const region = this.route.regionAt(km);
    const chance = region.pondsPerKm2 * 0.25 * (zone === 'village' ? 1.6 : zone === 'fields' ? 1 : 0.2);
    if (hash2(cx, cz, 43) < chance) {
      const nt = this.nearest(x, z, 120);
      const nearRoad = this.route.roads.some(r => r.kind === 'lc' && Math.abs((x - r.ax) * -r.dz + (z - r.az) * r.dx) < 60);
      const nearRiver = this.route.rivers.some(r => this.riverDistance(r, x, z) < r.width / 2 + 80);
      if (!nt && !nearRoad && !nearRiver) {
        p = { x, z, r: 14 + hash2(cx, cz, 44) * 16, level: this.natural(x, z, null) - 1.0 };
      }
    }
    this.pondCache.set(key, p);
    return p;
  }

  private roadInfo = { elev: 0, lat: 0 };

  /** LC road profile: rail level at the crossing, easing into natural ground. */
  lcRoadElevation(r: RoadDef, t: number) {
    const cx = r.ax + r.dx * t, cz = r.az + r.dz * t;
    const nat = this.natural(cx, cz, this.nearest(cx, cz));
    // smooth ramp from the crossing (rail level) to natural ground ~160 m away
    return lerp(r.railY - 0.06, nat, smoothstep(14, 170, Math.abs(t)));
  }

  /** Fill a ground sample at (x,z). */
  sample(x: number, z: number, out: GroundSample): GroundSample {
    const nt0 = this.nearest(x, z);
    // nearest() reuses one object; copy before nested calls
    const nt = nt0 ? { ...nt0 } : null;
    let h = this.natural(x, z, nt);
    out.natural = h;
    out.hole = false; out.river = Infinity; out.road = Infinity; out.pond = Infinity;

    for (const r of this.route.rivers) {
      const dr = this.riverDistance(r, x, z);
      if (dr === Infinity) continue;
      out.river = Math.min(out.river, dr);
      const half = r.width / 2;
      if (dr < half) h = Math.min(h, r.floor - 1.8 * (1 - (dr / half) ** 2));
      else if (dr < half + 170) h = Math.min(h, lerp(r.floor, h, smoothstep(half, half + 170, dr)));
    }

    const pcx = Math.floor(x / 500), pcz = Math.floor(z / 500);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const p = this.pondFor(pcx + i, pcz + j);
      if (!p) continue;
      const dp = Math.hypot(x - p.x, z - p.z);
      out.pond = Math.min(out.pond, dp - p.r);
      if (dp < p.r) h = Math.min(h, p.level - 1.4 * (1 - (dp / p.r) ** 2));
      else if (dp < p.r + 12) h = lerp(Math.min(h, p.level + 0.4), h, smoothstep(p.r, p.r + 12, dp));
    }

    for (const g of this.grounds) {
      const dg = Math.hypot(x - g.x, z - g.z);
      if (dg < g.r + 25) h = lerp(this.natural(g.x, g.z, null), h, smoothstep(g.r, g.r + 25, dg));
    }

    if (nt) h = this.carve(nt, h, out);
    h = this.roads(x, z, nt, h, out);
    out.h = h;
    out.nt = nt;
    return out;
  }

  private carve(nt: NearestTrack, h: number, out: GroundSample) {
    const R = this.route;
    const bed = R.alignment.elevationAt(nt.km);
    const km = nt.km;
    const H = R.halfSpacing; // double line: wider bore, wider bridge opening
    for (const t of R.tunnels) {
      if (km < t.fromKm - 0.004 || km > t.toKm + 0.004) continue;
      const nearPortal = km < t.fromKm + 0.02 || km > t.toKm - 0.02;
      if (nearPortal && nt.dist < 9.5 + H) out.hole = true;
      if (km > t.fromKm + 0.012 && km < t.toKm - 0.012) return nt.dist < 14 + H ? Math.max(h, bed + 13 + H * 0.5) : h;
    }
    for (const b of R.bridges) {
      if (km >= b.fromKm && km <= b.toKm) return nt.dist < 7 + H ? Math.min(h, bed - 3.5) : h;
    }
    const W = R.formationHalfWidth(km);
    const top = bed - 0.05;
    if (nt.dist <= W) return top;
    const s = (nt.dist - W) / 1.5;
    return h < top ? Math.max(h, top - s) : Math.min(h, top + s);
  }

  private roads(x: number, z: number, nt: NearestTrack | null, h: number, out: GroundSample) {
    for (const r of this.route.roads) {
      if (r.kind === 'lc') {
        const px = x - r.ax, pz = z - r.az;
        const t = px * r.dx + pz * r.dz;
        if (Math.abs(t) > r.halfLength) continue;
        const lat = Math.abs(px * -r.dz + pz * r.dx);
        if (lat > 16) continue;
        out.road = Math.min(out.road, lat);
        const e = this.lcRoadElevation(r, t) - 0.08;
        h = lerp(e, h, smoothstep(4.5, 16, lat));
      } else if (nt && r.fromKm !== undefined) {
        if (nt.km < r.fromKm! - 0.05 || nt.km > r.toKm! + 0.05) continue;
        const lat = Math.abs(nt.d - r.offset!);
        if (lat > 14) continue;
        const fade = smoothstep(r.fromKm! - 0.05, r.fromKm!, nt.km) * (1 - smoothstep(r.toKm!, r.toKm! + 0.05, nt.km));
        out.road = Math.min(out.road, lat + (1 - fade) * 100);
        const e = this.route.alignment.elevationAt(nt.km) - 0.12;
        h = lerp(h, lerp(e, h, smoothstep(4, 14, lat)), fade);
      }
    }
    this.roadInfo.lat = out.road;
    return h;
  }

  private tmp: GroundSample = { h: 0, hole: false, nt: null, river: 0, road: 0, pond: 0, natural: 0 };
  height(x: number, z: number) { return this.sample(x, z, this.tmp).h; }
}
