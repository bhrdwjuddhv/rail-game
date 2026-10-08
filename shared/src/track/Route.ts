import { Alignment, newFrame } from './Chainage';
import { formatGradient, parseGradient, ProfilePoint } from './Gradient';
import { SegmentDef } from './TrackSegment';
import { RAMP_M, RunningLine, TrackGraph } from './TrackGraph';

// ---------- data file shapes ----------
export interface CrossoverData { km: number; fromLine: string; toLine: string }
export interface StationData {
  name: string; nameHi: string; nameRegional: string; code: string; km: number;
  type: 'halt' | 'wayside' | 'junction' | 'terminal';
  platformLengthM: number; buildingSide: 1 | -1;
  /** loop lines (running lines may be listed too; they are implicit) */
  lines: { id: string; offset: number }[];
  platforms: { num: string; from: number; to: number; lines: string[] }[];
  crossovers?: CrossoverData[];
  /**
   * Freight crossing station: platformLengthM is then the standing length of
   * its loops (a 1.5 km train fits), and only a short, low service platform of
   * this length is built by the station building.
   */
  servicePlatformM?: number;
}
export interface StructureData {
  /** rob: a road over-bridge crossing the line (fromKm..toKm = its width) */
  type: 'bridge' | 'tunnel' | 'rob'; style?: 'girder' | 'steel-truss' | 'arch-viaduct';
  fromKm: number; toKm: number; name: string;
  river?: { width: number; depth: number; straight?: boolean };
}
export interface ZoneData { fromKm: number; toKm: number; zone: string; roadOffset?: number }
export interface RouteData {
  id: string; name: string; operator: string; lengthKm: number; startElevationM: number;
  /**
   * Running lines. Omitted (or one line) = single line "main". ["UP","DOWN"] =
   * double line: DOWN trains run toward increasing km on the left-hand line,
   * UP trains toward decreasing km; the lines sit lineSpacingM apart either
   * side of the surveyed centreline.
   */
  lines?: string[];
  lineSpacingM?: number;
  regions: { fromKm: number; toKm: number; region: string }[];
  segments: SegmentDef[];
  profile: ProfilePoint[];
  stations: StationData[];
  autoSignalSpacingKm: number;
  signals: { km: number; type: string; aspects?: number; offset?: number; line?: string }[];
  speedLimits: { fromKm: number; toKm: number; kmph: number }[];
  structures: StructureData[];
  levelCrossings: { km: number; manned: boolean }[];
  scenery: ZoneData[];
  features: { type: string; km: number }[];
  /** crossovers between running lines away from stations */
  crossovers?: CrossoverData[];
  /** contact wire height above rail (m): 5.55 standard, about 7.4 high-rise for double-stack containers */
  oheContactHeightM?: number;
  /** a dedicated freight corridor: only goods trains (traffic, menus) */
  freight?: boolean;
  /** the sea beside the line from fromKm past the route end: shore shoreM out on `side` (1 = Up side) */
  sea?: { fromKm: number; side: 1 | -1; shoreM: number };
}
export interface RegionData {
  id: string; name: string; ground: string[]; crops: { name: string; color: string }[];
  hillAmpNear: number; hillAmpFar: number; hillFreq: number; sideSlope: number;
  treeTypes: string[]; treeDensity: number; pondsPerKm2: number; kilnsPerKm2: number; villagesPerKm2: number;
  stationStyle: 'brick' | 'stone'; regionalScript: string;
  /**
   * Landscape type (default: ghats when sideSlope > 0, else plains). desert:
   * sand dunes away from the line, scrub; hills: rocky ridges and scrub;
   * coast: flat salt pans and sand by the sea.
   */
  biome?: 'plains' | 'ghats' | 'desert' | 'hills' | 'coast';
  /** height (m) of sand dunes away from the line */
  dunes?: number;
  /** share of ridged mountain crests in the distant hills (ghats default 0.9) */
  ridges?: number;
  /** wind turbines on high ground, per km2 */
  windTurbinesPerKm2?: number;
}

export const biomeOf = (r: RegionData) => r.biome ?? (r.sideSlope > 0 ? 'ghats' : 'plains');

// ---------- compiled shapes ----------
export type SignalKind = 'automatic' | 'distant' | 'home' | 'starter' | 'advanced-starter';
export interface SignalDef {
  id: string; km: number; kind: SignalKind; offset: number; aspects: 3 | 4;
  station?: string; line?: string; callingOn?: boolean; routeIndicator?: boolean;
}
export interface StationInfo extends StationData {
  platformFromKm: number; platformToKm: number;
  /** station limits for this direction: switch toes of its loops (or platform ends) */
  entryKm: number; exitKm: number;
  /** the whole yard, both directions (world building) */
  yardFromKm: number; yardToKm: number;
  /** lines this direction can be routed into: its running line, then its loops */
  lineInfo: { id: string; offset: number; fromKm: number; toKm: number }[];
  regionId: string;
}
export interface BoardDef { kind: 'km' | 'whistle' | 'speed' | 'caution' | 'termination' | 'gradient' | 'approach' | 'stop' | 'ghat'; km: number; text: string; offset: number }
export interface RiverDef { id: string; points: { x: number; z: number }[]; width: number; floor: number; water: number; bridgeKm: number; minX: number; maxX: number; minZ: number; maxZ: number }
export interface RoadDef { id: string; kind: 'lc' | 'parallel'; km: number; ax: number; az: number; dx: number; dz: number; halfLength: number; railY: number; fromKm?: number; toKm?: number; offset?: number }

export const STOP_MARKER_COACHES = [8, 12, 16, 20, 24];
export const LOCO_LENGTH_DEFAULT = 20.56;
export const DEFAULT_LINE_SPACING_M = 5.3;

export interface RouteOptions {
  /** running line this view is for (default: DOWN on a double line, main on a single line) */
  running?: string;
  /** data and alignment are the far-end-first mirror of the surveyed route (Up direction) */
  mirrored?: boolean;
  alignment?: Alignment;
}

/** Running lines of a route in surveyed (+km) coordinates: DOWN on the left of +km travel. */
export function runningLinesOf(data: RouteData): RunningLine[] {
  if (!data.lines || data.lines.length < 2) return [{ id: data.lines?.[0] ?? 'main', offset: 0 }];
  const h = (data.lineSpacingM ?? DEFAULT_LINE_SPACING_M) / 2;
  return [{ id: 'DOWN', offset: -h }, { id: 'UP', offset: h }];
}

/**
 * One direction's view of a route. On a single line there is one view; on a
 * double line each running direction gets its own, with chainage counted in
 * its direction of travel (the Up view is the route mirrored end to end), so
 * signalling, physics and AI all simply move toward increasing km.
 */
/** Length (km) at each tunnel end where the hill is cut back to the portal face. */
export const TUNNEL_PORTAL_KM = 0.012;

/** A freight yard beside the line (container depot or port): level ground from the line out to widthM on `side`. */
export interface YardDef { type: 'depot' | 'port'; km: number; fromKm: number; toKm: number; side: 1 | -1; widthM: number }

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
  /** container depot / port yards, from the route's features (surveyed km) */
  readonly yards: YardDef[];
  readonly mirrored: boolean;
  /** all running lines, in this view's coordinates */
  readonly runningLines: RunningLine[];
  /** this view's running line */
  readonly running: RunningLine;
  readonly double: boolean;
  /** half the track-centre spacing (0 on a single line): everything lineside moves out by this */
  readonly halfSpacing: number;

  constructor(readonly data: RouteData, readonly regions: Record<string, RegionData>, opts: RouteOptions = {}) {
    this.mirrored = !!opts.mirrored;
    this.alignment = opts.alignment ?? new Alignment(data.segments, data.profile, data.startElevationM);
    this.lengthKm = this.alignment.length / 1000;
    const lines = runningLinesOf(data);
    this.double = lines.length > 1;
    this.halfSpacing = this.double ? Math.abs(lines[0].offset) : 0;
    this.runningLines = this.mirrored ? lines.map(l => ({ id: l.id, offset: -l.offset })) : lines;
    const want = opts.running ?? (this.double ? (this.mirrored ? 'UP' : 'DOWN') : this.runningLines[0].id);
    this.running = this.runningLines.find(l => l.id === want) ?? this.runningLines[0];
    this.graph = new TrackGraph(this.lengthKm, this.runningLines);
    this.tunnels = data.structures.filter(s => s.type === 'tunnel');
    this.bridges = data.structures.filter(s => s.type === 'bridge');
    this.yards = data.features.filter(f => f.type === 'depot' || f.type === 'port').map(f => {
      const port = f.type === 'port';
      const fromKm = Math.max(0.05, f.km - 1.3), toKm = Math.min(this.lengthKm - 0.1, f.km + 1.6);
      return { type: f.type as 'depot' | 'port', km: f.km, fromKm, toKm, side: port ? (data.sea?.side ?? 1) : 1, widthM: port ? (data.sea?.shoreM ?? 150) : 120 };
    });
    for (const s of data.stations) this.compileStation(s);
    (data.crossovers ?? []).forEach((c, i) => this.addCrossover(c, `XO${i}`, undefined, []));
    this.compileSignals();
    this.compileBoards();
    if (!this.mirrored) { this.compileRivers(); this.compileRoads(); }
  }

  /** Surveyed km (as on the km posts) of a km in this view, and back. */
  canonicalKm(km: number) { return this.mirrored ? this.lengthKm - km : km; }
  viewKm(canonicalKm: number) { return this.mirrored ? this.lengthKm - canonicalKm : canonicalKm; }

  private isRunning(id: string) { return this.runningLines.some(l => l.id === id); }
  /** Running line a loop at `offset` branches from (the nearest one). */
  private parentOf(offset: number) {
    return this.runningLines.reduce((b, l) => (Math.abs(l.offset - offset) < Math.abs(b.offset - offset) ? l : b));
  }

  // ---------------- stations & switches ----------------
  private compileStation(s: StationData) {
    const half = s.platformLengthM / 2000;
    const run = this.running;
    const loops = s.lines.filter(l => !this.isRunning(l.id));
    const own = loops.filter(l => this.parentOf(l.offset).id === run.id);
    const st: StationInfo = {
      ...s,
      platformFromKm: s.km - half, platformToKm: s.km + half,
      entryKm: s.km - half, exitKm: s.km + half,
      yardFromKm: s.km - half - (loops.length ? 0.25 : 0), yardToKm: s.km + half + (loops.length ? 0.25 : 0),
      lineInfo: [{ id: run.id, offset: run.offset, fromKm: 0, toKm: this.lengthKm }],
      regionId: this.regionIdAt(s.km),
    };
    if (own.length) {
      st.entryKm = s.km - half - 0.25;
      st.exitKm = s.km + half + 0.25;
    }
    const r = RAMP_M / 1000;
    for (const l of own) {
      const li = { id: l.id, offset: l.offset, fromKm: st.entryKm + r, toKm: st.exitKm - r };
      st.lineInfo.push(li);
      this.graph.addLine({ ...li, id: `${s.code}-${l.id}`, station: s.code });
      this.graph.addSwitch({ id: `${s.code}-${l.id}-E`, station: s.code, kind: 'facing', from: run.offset, to: l.offset, rampStart: st.entryKm, rampEnd: st.entryKm + r });
      this.graph.addSwitch({ id: `${s.code}-${l.id}-X`, station: s.code, kind: 'trailing', from: l.offset, to: run.offset, rampStart: st.exitKm - r, rampEnd: st.exitKm });
    }
    (s.crossovers ?? []).forEach((c, i) => this.addCrossover(c, `${s.code}-XO${i}`, s.code, own));
    this.stations.push(st);
  }

  /** A crossover ramp; only built in views that have both of its lines. */
  private addCrossover(c: CrossoverData, id: string, station: string | undefined, own: { id: string; offset: number }[]) {
    const off = (lineId: string) => this.runningLines.find(l => l.id === lineId)?.offset ?? own.find(l => l.id === lineId)?.offset;
    const from = off(c.fromLine), to = off(c.toLine);
    if (from === undefined || to === undefined) return;
    this.graph.addSwitch({ id, station, kind: 'crossover', from, to, rampStart: c.km, rampEnd: c.km + RAMP_M / 1000 });
  }

  station(code: string) { return this.stations.find(s => s.code === code); }

  /**
   * Head km at which a train of `lengthM` should stop: at the stop marker for
   * its length class; a train longer than the longest marker (a goods train)
   * draws up to the far end, short of the starter signal.
   */
  stopKm(st: StationInfo, trainLengthM: number) {
    if (trainLengthM > LOCO_LENGTH_DEFAULT + 24 * 23.54 + 1) return st.platformToKm - 0.025;
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
    const run = this.running;
    const ro = run.offset;
    // per-line numbering on a double line: D7 / U7, RNPJ-DH / RNPJ-UH
    const p = this.double ? run.id[0] : '';
    const sid = (code: string, k: string) => `${code}-${p}${k}`;
    const sig: SignalDef[] = [];
    for (const st of this.stations) {
      if (st.type === 'halt') continue;
      const home = st.entryKm - 0.18;
      if (home - 1.2 > 0.05) sig.push({ id: sid(st.code, 'D'), km: home - 1.2, kind: 'distant', offset: ro, aspects: 4, station: st.code });
      if (home > 0.05) sig.push({ id: sid(st.code, 'H'), km: home, kind: 'home', offset: ro, aspects: 4, station: st.code, callingOn: true, routeIndicator: st.type === 'junction' });
      for (const l of st.lineInfo) {
        sig.push({ id: sid(st.code, `S-${l.id}`), km: st.platformToKm + 0.03, kind: 'starter', offset: l.offset, aspects: 4, station: st.code, line: l.id });
      }
      if (st.type !== 'terminal' && st.exitKm + 0.4 < this.lengthKm - 0.2) {
        sig.push({ id: sid(st.code, 'AS'), km: st.exitKm + 0.4, kind: 'advanced-starter', offset: ro, aspects: 4, station: st.code });
      }
    }
    // automatic block signals fill the gaps between station limits
    const spacing = this.data.autoSignalSpacingKm;
    const anchors = sig.filter(s => Math.abs(s.offset - ro) < 0.01).map(s => s.km).sort((a, b) => a - b);
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
        sig.push({ id: this.double ? `${p}${++n}` : `A${++n}`, km, kind: 'automatic', offset: ro, aspects: 4 });
      }
    }
    for (const s of this.data.signals) {
      if (s.line && s.line !== run.id) continue;
      sig.push({ id: `X${p}${s.km}`, km: s.km, kind: (s.type as SignalKind) || 'automatic', offset: s.offset ?? ro, aspects: (s.aspects as 3 | 4) ?? 4 });
    }
    sig.sort((a, b) => a.km - b.km);
    this.signals.push(...sig);
  }

  // ---------------- boards ----------------
  private compileBoards() {
    const B = this.boards;
    // boards stand on the outer (left) side of this direction's line
    const left = (d: number) => this.running.offset - d;
    for (let k = 1; k < this.lengthKm; k++) B.push({ kind: 'km', km: this.viewKm(k), text: String(k), offset: left(3.6) });
    for (const lc of this.data.levelCrossings) B.push({ kind: 'whistle', km: lc.km - 0.6, text: 'W/L', offset: left(3.4) });
    for (const t of this.tunnels) B.push({ kind: 'whistle', km: t.fromKm - 0.5, text: 'W', offset: left(3.4) });
    const lim = [...this.data.speedLimits].sort((a, b) => a.fromKm - b.fromKm);
    for (let i = 1; i < lim.length; i++) {
      const prev = lim[i - 1], cur = lim[i];
      if (cur.kmph < prev.kmph) {
        if (cur.fromKm - 1 > 0) B.push({ kind: 'caution', km: cur.fromKm - 1, text: String(cur.kmph), offset: left(3.4) });
        B.push({ kind: 'speed', km: cur.fromKm, text: String(cur.kmph), offset: left(3.4) });
      } else if (cur.kmph > prev.kmph) {
        B.push({ kind: 'termination', km: cur.fromKm, text: 'T', offset: left(3.4) });
      }
    }
    const prof = [...this.data.profile].sort((a, b) => a.km - b.km);
    for (const p of prof) {
      if (p.km <= 0) continue;
      const g = parseGradient(p.gradient);
      // single line: right-hand side as before; double line: the right side is the other track
      B.push({
        kind: 'gradient', km: p.km + (this.double ? 0.012 : 0), offset: this.double ? left(3.6) : this.running.offset + 3.6,
        text: g === 0 ? 'LEVEL' : formatGradient(g).replace('1 in ', '1/').replace(' up', ' ↑').replace(' down', ' ↓'),
      });
    }
    const ghat = this.data.regions.find(r => this.regions[r.region]?.sideSlope > 0);
    if (ghat) B.push({ kind: 'ghat', km: Math.max(0.05, ghat.fromKm) + 0.15, text: 'GHAT SECTION', offset: left(3.6) });
    for (const st of this.stations) {
      if (st.platformFromKm - 1 > 0) B.push({ kind: 'approach', km: st.platformFromKm - 1, text: st.code, offset: left(3.6) });
      const pf = st.platforms.find(p => p.lines.includes(this.running.id)) ?? st.platforms[0];
      const side = Math.sign(pf.from) || 1;
      for (const c of STOP_MARKER_COACHES) {
        B.push({ kind: 'stop', km: this.markerKm(st, c), text: String(c), offset: side * (Math.abs(pf.from) + 0.5) });
      }
    }
    B.sort((a, b) => a.km - b.km);
  }

  // ---------------- rivers & roads (surveyed view only: they are world features) ----------------
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
    const sea = this.data.sea;
    if (sea) {
      // a 3 km wide straight "river" whose near bank is the shore, running on 3 km past the end of the line
      const W = 3000, lat = sea.side * (sea.shoreM + W / 2), end = this.alignment.length;
      const pts: { x: number; z: number }[] = [];
      for (let s = sea.fromKm * 1000; s <= end + 3000; s += 25) {
        this.alignment.sampleOffset(Math.min(s, end), lat, f);
        const over = Math.max(0, s - end);
        pts.push({ x: f.x + Math.cos(f.heading) * over, z: f.z + Math.sin(f.heading) * over });
      }
      const floor = this.alignment.elevationAt(Math.min(sea.fromKm * 1000, end) / 1000) - 9;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
      this.rivers.push({ id: 'Sea', points: pts, width: W, floor, water: floor + 6, bridgeKm: -1, minX, maxX, minZ, maxZ });
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
  /**
   * Regions around km with weights summing to 1, blended over 1.5 km at
   * their borders (terrain shape, ground colour and vegetation follow it).
   */
  regionWeights(km: number): { r: RegionData; w: number }[] {
    const out: { r: RegionData; w: number }[] = [];
    let sum = 0;
    for (const e of this.data.regions) {
      const r = this.regions[e.region];
      if (!r) continue;
      const d = km < e.fromKm ? e.fromKm - km : km > e.toKm ? km - e.toKm : 0;
      const w = Math.max(0, 1 - d / 1.5);
      if (w <= 0) continue;
      const same = out.find(o => o.r === r);
      if (same) same.w = Math.max(same.w, w); else out.push({ r, w });
    }
    for (const o of out) sum += o.w;
    if (!sum) return [{ r: this.regionAt(km), w: 1 }];
    for (const o of out) o.w /= sum;
    return out;
  }
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
  /** Inside a tunnel bore away from its portals: the hill stands closed over the track here. */
  overTunnel(km: number) { return this.tunnels.some(t => km > t.fromKm + TUNNEL_PORTAL_KM && km < t.toKm - TUNNEL_PORTAL_KM); }
  /** Station whose yard (either direction) covers km. */
  stationAt(km: number, margin = 0) {
    return this.stations.find(s => km >= s.yardFromKm - margin && km <= s.yardToKm + margin);
  }
  /** Half-width of the cleared formation (both lines, loops, platforms, station area). */
  formationHalfWidth(km: number) {
    const base = 6.5 + this.halfSpacing;
    const st = this.stationAt(km, 0.05);
    if (!st) return base;
    let w = base;
    for (const l of st.lines) w = Math.max(w, Math.abs(l.offset) + 4);
    const half = (st.servicePlatformM ?? st.platformLengthM) / 2000;
    if (km >= st.km - half - 0.06 && km <= st.km + half + 0.06) {
      for (const p of st.platforms) w = Math.max(w, Math.abs(p.from) + 1, Math.abs(p.to) + 1);
      w += 22; // station building / circulating area
    }
    return w;
  }
}
