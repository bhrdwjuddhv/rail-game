import { Alignment, newFrame } from './Chainage';
import { formatGradient, parseGradient, ProfilePoint } from './Gradient';
import { SegmentDef } from './TrackSegment';
import { RAMP_M, TrackGraph } from './TrackGraph';

// ---------- data file shapes ----------
export interface StationData {
  name: string; nameHi: string; nameRegional: string; code: string; km: number;
  type: 'halt' | 'wayside' | 'junction' | 'terminal';
  platformLengthM: number; buildingSide: 1 | -1;
  lines: { id: string; offset: number }[];
  platforms: { num: string; from: number; to: number; lines: string[] }[];
  crossovers?: { km: number; fromLine: string; toLine: string }[];
}
export interface StructureData {
  type: 'bridge' | 'tunnel'; style?: 'girder' | 'steel-truss' | 'arch-viaduct';
  fromKm: number; toKm: number; name: string;
  river?: { width: number; depth: number; straight?: boolean };
}
export interface ZoneData { fromKm: number; toKm: number; zone: string; roadOffset?: number }
export interface RouteData {
  id: string; name: string; operator: string; lengthKm: number; startElevationM: number;
  regions: { fromKm: number; toKm: number; region: string }[];
  segments: SegmentDef[];
  profile: ProfilePoint[];
  stations: StationData[];
  autoSignalSpacingKm: number;
  signals: { km: number; type: string; aspects?: number; offset?: number }[];
  speedLimits: { fromKm: number; toKm: number; kmph: number }[];
  structures: StructureData[];
  levelCrossings: { km: number; manned: boolean }[];
  scenery: ZoneData[];
  features: { type: string; km: number }[];
}
export interface RegionData {
  id: string; name: string; ground: string[]; crops: { name: string; color: string }[];
  hillAmpNear: number; hillAmpFar: number; hillFreq: number; sideSlope: number;
  treeTypes: string[]; treeDensity: number; pondsPerKm2: number; kilnsPerKm2: number; villagesPerKm2: number;
  stationStyle: 'brick' | 'stone'; regionalScript: string;
}

// ---------- compiled shapes ----------
export type SignalKind = 'automatic' | 'distant' | 'home' | 'starter' | 'advanced-starter';
export interface SignalDef {
  id: string; km: number; kind: SignalKind; offset: number; aspects: 3 | 4;
  station?: string; line?: string; callingOn?: boolean; routeIndicator?: boolean;
}
export interface StationInfo extends StationData {
  platformFromKm: number; platformToKm: number;
  entryKm: number; exitKm: number; // switch toes (loops) or platform ends (halts)
  lineInfo: { id: string; offset: number; fromKm: number; toKm: number }[];
  regionId: string;
}
export interface BoardDef { kind: 'km' | 'whistle' | 'speed' | 'caution' | 'termination' | 'gradient' | 'approach' | 'stop' | 'ghat'; km: number; text: string; offset: number }
export interface RiverDef { id: string; points: { x: number; z: number }[]; width: number; floor: number; water: number; bridgeKm: number; minX: number; maxX: number; minZ: number; maxZ: number }
export interface RoadDef { id: string; kind: 'lc' | 'parallel'; km: number; ax: number; az: number; dx: number; dz: number; halfLength: number; railY: number; fromKm?: number; toKm?: number; offset?: number }

export const STOP_MARKER_COACHES = [8, 12, 16, 20, 24];
export const LOCO_LENGTH_DEFAULT = 20.56;

export class Route {
  readonly alignment: Alignment;
  readonly graph: TrackGraph;
  readonly lengthKm: number;
  readonly stations: StationInfo[] = [];
  readonly signals: SignalDef[] = [];
  readonly boards: BoardDef[] = [];
  readonly rivers: RiverDef[] = [];
  readonly roads: RoadDef[] = [];
  readonly tunnels: StructureData[];
  readonly bridges: StructureData[];

  constructor(readonly data: RouteData, readonly regions: Record<string, RegionData>) {
    this.alignment = new Alignment(data.segments, data.profile, data.startElevationM);
    this.lengthKm = this.alignment.length / 1000;
    this.graph = new TrackGraph(this.lengthKm);
    this.tunnels = data.structures.filter(s => s.type === 'tunnel');
    this.bridges = data.structures.filter(s => s.type === 'bridge');
    for (const s of data.stations) this.compileStation(s);
    this.compileSignals();
    this.compileBoards();
    this.compileRivers();
    this.compileRoads();
  }

  // ---------------- stations & switches ----------------
  private compileStation(s: StationData) {
    const half = s.platformLengthM / 2000;
    const st: StationInfo = {
      ...s,
      platformFromKm: s.km - half, platformToKm: s.km + half,
      entryKm: s.km - half, exitKm: s.km + half, lineInfo: [],
      regionId: this.regionIdAt(s.km),
    };
    const loops = s.lines.filter(l => l.offset !== 0);
    if (loops.length) {
      st.entryKm = s.km - half - 0.25;
      st.exitKm = s.km + half + 0.25;
    }
    const r = RAMP_M / 1000;
    for (const l of s.lines) {
      if (l.offset === 0) { st.lineInfo.push({ id: l.id, offset: 0, fromKm: 0, toKm: this.lengthKm }); continue; }
      const li = { id: l.id, offset: l.offset, fromKm: st.entryKm + r, toKm: st.exitKm - r };
      st.lineInfo.push(li);
      this.graph.addLine({ ...li, id: `${s.code}-${l.id}`, station: s.code });
      this.graph.addSwitch({ id: `${s.code}-${l.id}-E`, station: s.code, kind: 'facing', from: 0, to: l.offset, rampStart: st.entryKm, rampEnd: st.entryKm + r });
      this.graph.addSwitch({ id: `${s.code}-${l.id}-X`, station: s.code, kind: 'trailing', from: l.offset, to: 0, rampStart: st.exitKm - r, rampEnd: st.exitKm });
    }
    for (const c of s.crossovers ?? []) {
      const from = s.lines.find(l => l.id === c.fromLine)!.offset;
      const to = s.lines.find(l => l.id === c.toLine)!.offset;
      this.graph.addSwitch({ id: `${s.code}-XO-${c.fromLine}`, station: s.code, kind: 'crossover', from, to, rampStart: c.km, rampEnd: c.km + r });
    }
    this.stations.push(st);
  }

  station(code: string) { return this.stations.find(s => s.code === code); }

  /** Head km at which a train of `lengthM` should stop: at the stop marker for its length class. */
  stopKm(st: StationInfo, trainLengthM: number) {
    const coaches = Math.max(0, (trainLengthM - LOCO_LENGTH_DEFAULT) / 23.54);
    const cls = STOP_MARKER_COACHES.find(c => c >= coaches - 0.01) ?? 24;
    return this.markerKm(st, cls);
  }
  markerKm(st: StationInfo, coaches: number) {
    const len = LOCO_LENGTH_DEFAULT + coaches * 23.54;
    return Math.min(st.platformToKm - 0.008, st.km + len / 2000);
  }

  // ---------------- signals ----------------
  private compileSignals() {
    const sig: SignalDef[] = [];
    for (const st of this.stations) {
      if (st.type === 'halt') continue;
      const home = st.entryKm - 0.18;
      if (home - 1.2 > 0.05) sig.push({ id: `${st.code}-D`, km: home - 1.2, kind: 'distant', offset: 0, aspects: 4, station: st.code });
      if (home > 0.05) sig.push({ id: `${st.code}-H`, km: home, kind: 'home', offset: 0, aspects: 4, station: st.code, callingOn: true, routeIndicator: st.type === 'junction' });
      for (const l of st.lineInfo) {
        sig.push({ id: `${st.code}-S-${l.id}`, km: st.platformToKm + 0.03, kind: 'starter', offset: l.offset, aspects: 4, station: st.code, line: l.id });
      }
      if (st.type !== 'terminal' && st.exitKm + 0.4 < this.lengthKm - 0.2) {
        sig.push({ id: `${st.code}-AS`, km: st.exitKm + 0.4, kind: 'advanced-starter', offset: 0, aspects: 4, station: st.code });
      }
    }
    // automatic block signals fill the gaps between station limits
    const spacing = this.data.autoSignalSpacingKm;
    const anchors = sig.filter(s => s.offset === 0).map(s => s.km).sort((a, b) => a - b);
    const bounds = [0, ...anchors, this.lengthKm - 0.3];
    let n = 0;
    for (let i = 0; i < bounds.length - 1; i++) {
      const a = bounds[i], b = bounds[i + 1];
      const gap = b - a;
      if (gap < spacing * 1.25) continue;
      // don't put autos inside station limits (between home and advanced starter)
      const inside = this.stations.some(st => st.type !== 'halt' && a >= st.entryKm - 0.2 && b <= st.exitKm + 0.45);
      if (inside) continue;
      const count = Math.floor(gap / spacing);
      for (let k = 1; k <= count; k++) {
        let km = a + (gap * k) / (count + 1);
        const halt = this.stations.find(st => st.type === 'halt' && km > st.platformFromKm - 0.15 && km < st.platformToKm + 0.05);
        if (halt) km = halt.platformToKm + 0.05;
        sig.push({ id: `A${++n}`, km, kind: 'automatic', offset: 0, aspects: 4 });
      }
    }
    for (const s of this.data.signals) {
      sig.push({ id: `X${s.km}`, km: s.km, kind: (s.type as SignalKind) || 'automatic', offset: s.offset ?? 0, aspects: (s.aspects as 3 | 4) ?? 4 });
    }
    sig.sort((a, b) => a.km - b.km);
    this.signals.push(...sig);
  }

  // ---------------- boards ----------------
  private compileBoards() {
    const B = this.boards;
    for (let k = 1; k < this.lengthKm; k++) B.push({ kind: 'km', km: k, text: String(k), offset: -3.6 });
    for (const lc of this.data.levelCrossings) B.push({ kind: 'whistle', km: lc.km - 0.6, text: 'W/L', offset: -3.4 });
    for (const t of this.tunnels) B.push({ kind: 'whistle', km: t.fromKm - 0.5, text: 'W', offset: -3.4 });
    const lim = [...this.data.speedLimits].sort((a, b) => a.fromKm - b.fromKm);
    for (let i = 1; i < lim.length; i++) {
      const prev = lim[i - 1], cur = lim[i];
      if (cur.kmph < prev.kmph) {
        if (cur.fromKm - 1 > 0) B.push({ kind: 'caution', km: cur.fromKm - 1, text: String(cur.kmph), offset: -3.4 });
        B.push({ kind: 'speed', km: cur.fromKm, text: String(cur.kmph), offset: -3.4 });
      } else if (cur.kmph > prev.kmph) {
        B.push({ kind: 'termination', km: cur.fromKm, text: 'T', offset: -3.4 });
      }
    }
    const prof = [...this.data.profile].sort((a, b) => a.km - b.km);
    for (const p of prof) {
      if (p.km <= 0) continue;
      const g = parseGradient(p.gradient);
      B.push({ kind: 'gradient', km: p.km, text: g === 0 ? 'LEVEL' : formatGradient(g).replace('1 in ', '1/').replace(' up', ' ↑').replace(' down', ' ↓'), offset: 3.6 });
    }
    const ghat = this.data.regions.find(r => this.regions[r.region]?.sideSlope > 0);
    if (ghat) B.push({ kind: 'ghat', km: ghat.fromKm + 0.15, text: 'GHAT SECTION', offset: -3.6 });
    for (const st of this.stations) {
      if (st.platformFromKm - 1 > 0) B.push({ kind: 'approach', km: st.platformFromKm - 1, text: st.code, offset: -3.6 });
      const pf = st.platforms.find(p => p.lines.includes('main')) ?? st.platforms[0];
      const side = Math.sign(pf.from) || 1;
      for (const c of STOP_MARKER_COACHES) {
        B.push({ kind: 'stop', km: this.markerKm(st, c), text: String(c), offset: side * (Math.abs(pf.from) + 0.5) });
      }
    }
    B.sort((a, b) => a.km - b.km);
  }

  // ---------------- rivers & roads ----------------
  private compileRivers() {
    const f = newFrame();
    for (const b of this.bridges) {
      if (!b.river) continue;
      const mid = (b.fromKm + b.toKm) / 2;
      this.alignment.sample(mid * 1000, f);
      const tx = Math.cos(f.heading), tz = Math.sin(f.heading);
      const nx = -tz, nz = tx;
      const big = b.river.width > 100;
      const L = big ? 4500 : 1800;
      const pts: { x: number; z: number }[] = [];
      const phase = mid * 3.1;
      for (let t = -L; t <= L; t += 25) {
        const a = b.river.straight ? 0 : Math.min(Math.abs(t) * 0.12, big ? 220 : 90);
        const m = a * Math.sin(t / (big ? 520 : 260) + phase);
        pts.push({ x: f.x + nx * t + tx * m, z: f.z + nz * t + tz * m });
      }
      const floor = f.y - b.river.depth;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
      this.rivers.push({ id: b.name, points: pts, width: b.river.width, floor, water: floor + (big ? 3 : 1.2), bridgeKm: mid, minX, maxX, minZ, maxZ });
    }
  }

  private compileRoads() {
    const f = newFrame();
    this.data.levelCrossings.forEach((lc, i) => {
      this.alignment.sample(lc.km * 1000, f);
      this.roads.push({ id: `LC${i}`, kind: 'lc', km: lc.km, ax: f.x, az: f.z, dx: -Math.sin(f.heading), dz: Math.cos(f.heading), halfLength: 1400, railY: f.y + 0.63 });
    });
    this.data.scenery.forEach((z, i) => {
      if (z.roadOffset) this.roads.push({ id: `PR${i}`, kind: 'parallel', km: z.fromKm, ax: 0, az: 0, dx: 0, dz: 0, halfLength: 0, railY: 0, fromKm: z.fromKm, toKm: z.toKm, offset: z.roadOffset });
    });
  }

  // ---------------- lookups ----------------
  speedLimitAt(km: number) {
    for (const l of this.data.speedLimits) if (km >= l.fromKm && km < l.toKm) return l.kmph;
    return 30;
  }
  zoneAt(km: number): ZoneData {
    for (const z of this.data.scenery) if (km >= z.fromKm && km < z.toKm) return z;
    return this.data.scenery[this.data.scenery.length - 1];
  }
  regionIdAt(km: number) {
    for (const r of this.data.regions) if (km >= r.fromKm && km < r.toKm) return r.region;
    return this.data.regions[this.data.regions.length - 1].region;
  }
  regionAt(km: number) { return this.regions[this.regionIdAt(km)]; }
  /** 0 = plains-like, 1 = ghats-like, blended over 1.5 km at region borders. */
  ghatFactor(km: number) {
    let best = 0;
    for (const r of this.data.regions) {
      if (!(this.regions[r.region]?.sideSlope > 0)) continue;
      const d = km < r.fromKm ? r.fromKm - km : km > r.toKm ? km - r.toKm : 0;
      best = Math.max(best, 1 - Math.min(1, d / 1.5));
    }
    return best;
  }
  structureAt(km: number) {
    for (const s of this.data.structures) if (km >= s.fromKm && km <= s.toKm) return s;
    return null;
  }
  inTunnel(km: number) { return this.tunnels.some(t => km >= t.fromKm && km <= t.toKm); }
  stationAt(km: number, margin = 0) {
    return this.stations.find(s => km >= s.entryKm - margin && km <= s.exitKm + margin);
  }
  formationHalfWidth(km: number) {
    const st = this.stationAt(km, 0.05);
    if (!st) return 6.5;
    let w = 6.5;
    for (const l of st.lineInfo) w = Math.max(w, Math.abs(l.offset) + 4);
    if (km >= st.platformFromKm - 0.06 && km <= st.platformToKm + 0.06) {
      for (const p of st.platforms) w = Math.max(w, Math.abs(p.from) + 1, Math.abs(p.to) + 1);
      w += 22; // station building / circulating area
    }
    return w;
  }
}
