import { AdFormat, BillboardType, TYPE_FORMAT, AdSettings } from '@rail/shared/ads/Ads';
import { newFrame, RAIL_TOP } from '@rail/shared/track/Chainage';
import type { Railway } from '@rail/shared/track/Railway';
import { biomeOf, type StationInfo } from '@rail/shared/track/Route';
import { hash2 } from '@rail/shared/util';
import type { GroundSample, TerrainField } from '../TerrainField';

/** platform top above the line (as Station.ts builds it) */
const PLATFORM_H = RAIL_TOP + 0.76;

/**
 * Billboard slots along a route: where every billboard stands, planned once
 * per route (the same every time) along the chainage, on both sides of the
 * line, outside the track corridor and the masts, and turned toward the trains
 * that will read them.
 *
 * Each roadside slot must be readable from the cab: sight lines from the driver's
 * eye 100-400 m before it (on the line whose trains it faces) must clear the
 * ground, stations, bridges and tunnels. A blocked slot is moved along the line
 * or to the other side, or dropped. Its clear zone (the ground between those
 * eyes and the board) is kept free of trees and buildings by the scenery
 * placement, so nothing grows or is built in the way later.
 *
 * Safety: no billboard just before a signal (it could hide it, or be mistaken
 * for one), at a signal or a lineside board, at a level crossing (only small
 * kiosks there), on bridges, near tunnels or in the wild (gorges, waterfall
 * views); lamps are dimmed near signals and LED screens kept away from them.
 */

export interface BillboardSlot {
  id: number;
  type: BillboardType;
  format: AdFormat;
  /** surveyed metres along the route; side: + right of increasing km */
  s: number; side: 1 | -1; lat: number;
  /** world position of the base (ground, or platform / deck level), yaw: local +z = the face */
  x: number; y: number; z: number; ry: number;
  /** a second face (V-shaped hoardings) at this yaw */
  ry2?: number;
  /** the lowest ground under the structure (legs reach down to it) */
  footY: number;
  region: string;
  style: 'clean' | 'rusty' | 'weathered';
  status: 'ok' | 'moved' | 'dropped';
  /** near a signal: lamps off, no bright colours at night */
  dim: boolean;
  /** clear zone: convex polygon x0,z0,x1,z1... (world) where nothing tall may stand */
  zone: number[];
}

/** Panel size (m) and its bottom edge above the base, the distance out from the outer running line, and the turn toward the trains (deg from parallel: well round, so the faces read from the cab). */
export const SPEC: Record<BillboardType, { w: number; h: number; bottom: number; setback: number; angle: number; foot: number }> = {
  classic: { w: 6.4, h: 3.2, bottom: 4.6, setback: 11, angle: 42, foot: 2.2 },
  wide: { w: 12, h: 4, bottom: 5.4, setback: 15, angle: 38, foot: 5.2 },
  vshape: { w: 6.4, h: 3.2, bottom: 4.6, setback: 13, angle: 48, foot: 2.6 },
  unipole: { w: 10.5, h: 3.5, bottom: 12, setback: 19, angle: 36, foot: 1.2 },
  rooftop: { w: 9, h: 3, bottom: 10.6, setback: 22, angle: 32, foot: 6.5 },
  wall: { w: 7.2, h: 2.4, bottom: 0.45, setback: 9, angle: 16, foot: 0.6 },
  kiosk: { w: 1.2, h: 2.4, bottom: 0.7, setback: 7, angle: 42, foot: 0.6 },
  led: { w: 6.4, h: 3.6, bottom: 5, setback: 13, angle: 42, foot: 2.4 },
  platform: { w: 3, h: 1.5, bottom: 0.9, setback: 0, angle: 0, foot: 1.5 },
  fob: { w: 7, h: 1.4, bottom: 0.3, setback: 0, angle: 90, foot: 0 },
};

const EYE_H = 3.8;
const EYE_D = [100, 175, 250, 325, 400];
const WILD = new Set(['ghats', 'snow', 'river']);

export interface PlanStats { slots: number; ok: number; moved: number; dropped: number; byType: Partial<Record<BillboardType, number>> }

export function planBillboards(railway: Railway, field: TerrainField, settings: AdSettings): { slots: BillboardSlot[]; dropped: BillboardSlot[]; stats: PlanStats } {
  const route = railway.main, L = route.alignment.length;
  const H = route.halfSpacing;
  const f = newFrame(), g = newFrame();
  const S: GroundSample = { h: 0, hole: false, nt: null, river: 0, waterY: 0, road: 0, pond: 0, natural: 0 };
  const slots: BillboardSlot[] = [], dropped: BillboardSlot[] = [];
  let nextId = 1, leds = 0;

  // ---- keep-out ranges along the line (surveyed metres) ----
  const yards = route.stations.map(st => ({ st, a: (st.yardFromKm - 0.12) * 1000, b: (st.yardToKm + 0.12) * 1000 }));
  const structures = route.data.structures.map(x => ({ a: x.fromKm * 1000 - 120, b: x.toKm * 1000 + 120, type: x.type }));
  const lcs = route.data.levelCrossings.map(l => l.km * 1000);
  const wildSpots = route.data.features.filter(x => x.type === 'waterfall').map(x => x.km * 1000);
  // signals and lineside boards of both directions, with the direction their trains run (+1: toward increasing km)
  const signals: { s: number; dir: number }[] = [], boards: number[] = [];
  for (const v of railway.views) {
    const dir = v.mirrored ? -1 : 1;
    for (const sg of v.signals) signals.push({ s: v.canonicalKm(sg.km) * 1000, dir });
    for (const b of v.boards) boards.push(v.canonicalKm(b.km) * 1000);
  }
  const allowed = (s: number, type: BillboardType) => {
    if (s < 250 || s > L - 250) return false;
    if (yards.some(y => s > y.a && s < y.b)) return false;
    if (structures.some(x => s > x.a && s < x.b)) return false;
    if (type !== 'kiosk' && lcs.some(l => Math.abs(s - l) < 140)) return false;
    // never in the 200 m before a signal (in its trains' direction), nor at one or at a board
    if (signals.some(sg => { const d = (s - sg.s) * sg.dir; return d > -200 && d < 30; })) return false;
    if (boards.some(b => Math.abs(s - b) < 30)) return false;
    if (wildSpots.some(w => Math.abs(s - w) < 500)) return false;
    return true;
  };
  const dimAt = (s: number) => signals.some(sg => Math.abs(s - sg.s) < 400);
  /** LED screens: bright and changing, so well away from signals */
  const ledClear = (s: number) => !signals.some(sg => Math.abs(s - sg.s) < 250);

  // ---- placing one board ----
  const place = (type: BillboardType, s: number, side: 1 | -1): BillboardSlot | null => {
    const sp = SPEC[type];
    const lat = side * (H + 1.6 + sp.setback);
    if (Math.abs(lat) < route.formationHalfWidth(s / 1000) + 2) return null;
    // a parallel road on this side: keep clear of it
    for (const z of route.data.scenery) if (z.roadOffset && Math.sign(z.roadOffset) === side && s / 1000 >= z.fromKm - 0.1 && s / 1000 <= z.toKm + 0.1 && Math.abs(Math.abs(lat) - Math.abs(z.roadOffset)) < sp.w / 2 + 8) return null;
    route.alignment.sampleOffset(s, lat, f);
    const t = { x: Math.cos(f.heading), z: Math.sin(f.heading) }, n = { x: -Math.sin(f.heading), z: Math.cos(f.heading) };
    // face: toward the line (-side) and toward the trains it faces (Down trains come from lower km on the left, Up trains from higher km on the right)
    const a = (sp.angle * Math.PI) / 180;
    const nx = -side * n.x * Math.cos(a) + side * t.x * Math.sin(a), nz = -side * n.z * Math.cos(a) + side * t.z * Math.sin(a);
    const ry = Math.atan2(nx, nz);
    // ground under the footprint: no water, not too steep; the structure stands on the highest point
    let hi = -Infinity, lo = Infinity;
    for (const [u, v] of [[0, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const px = f.x + Math.cos(ry) * u * (sp.w / 2 + 0.5) + Math.sin(ry) * v * sp.foot / 2;
      const pz = f.z - Math.sin(ry) * u * (sp.w / 2 + 0.5) + Math.cos(ry) * v * sp.foot / 2;
      field.sample(px, pz, S);
      if (S.river < 6 || S.pond < 6 || S.hole) return null;
      hi = Math.max(hi, S.h); lo = Math.min(lo, S.h);
    }
    if (hi - lo > (type === 'wall' || type === 'rooftop' ? 1.6 : 3.2)) return null;
    // sight lines from the cab (the facing line), through the ground and past stations, tunnels and bridges
    const eyeLat = side * H, dir = side < 0 ? -1 : 1; // eyes before the board in the trains' direction
    const panelY = hi + sp.bottom + sp.h / 2;
    let clear = 0, tested = 0;
    const eyes: { x: number; z: number }[] = [];
    for (const d of EYE_D) {
      const es = s + dir * d;
      if (es < 0 || es > L) continue;
      tested++;
      if (structures.some(x => (x.type !== 'bridge') && Math.min(es, s) < x.b - 120 && Math.max(es, s) > x.a + 120)) continue; // a tunnel or road bridge in between
      if (yards.some(y => Math.min(es, s) < y.b && Math.max(es, s) > y.a)) continue;                                      // a station in between
      route.alignment.sampleOffset(es, eyeLat, g);
      const ey = g.y + EYE_H;
      const dx = f.x - g.x, dz = f.z - g.z, dist = Math.hypot(dx, dz);
      // the face must turn toward this eye
      if ((nx * -dx + nz * -dz) / dist < 0.25) continue;
      let ok = true;
      const steps = Math.ceil(dist / 14);
      for (let k = 1; k < steps - 1 && ok; k++) {
        const q = k / steps;
        const lineY = ey + (panelY - ey) * q;
        if (field.height(g.x + dx * q, g.z + dz * q) > lineY - 0.4) ok = false;
      }
      if (ok) { clear++; eyes.push({ x: g.x, z: g.z }); }
    }
    if (tested < 3 || clear < 3) return null;
    // clear zone: from the farthest and nearest clear eyes to the panel and its footprint
    const half = sp.w / 2 + 2.5, pts: [number, number][] = [];
    for (const e of [eyes[0], eyes[eyes.length - 1]]) pts.push([e.x, e.z]);
    for (const [u, v] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) pts.push([f.x + Math.cos(ry) * u * half + Math.sin(ry) * v * (sp.foot / 2 + 3), f.z - Math.sin(ry) * u * half + Math.cos(ry) * v * (sp.foot / 2 + 3)]);
    const region = route.regionIdAt(s / 1000), reg = route.regions[region], b = reg ? biomeOf(reg) : 'plains';
    const zone = route.zoneAt(s / 1000).zone;
    return {
      id: nextId++, type, format: TYPE_FORMAT[type], s, side, lat, x: f.x, y: hi, z: f.z, ry, footY: lo, region,
      style: zone === 'town' || zone === 'south-town' || zone === 'colony' || zone === 'terminal' ? 'clean' : b === 'desert' || b === 'coast' ? 'rusty' : 'weathered',
      status: 'ok', dim: dimAt(s), zone: hull(pts),
    };
  };

  const sameSideClear = (s: number, side: number) => !slots.some(o => o.side === side && Math.abs(o.s - s) < settings.minGapMetres);
  /** try the spot, then a little along the line either way, then the other side */
  const tryPlace = (type: BillboardType, s0: number, side0: 1 | -1) => {
    for (const side of [side0, -side0 as 1 | -1]) for (const ds of [0, 40, -40, 90, -90, 150, -150, 220, -220]) {
      const s = s0 + ds;
      if (!allowed(s, type) || !sameSideClear(s, side) || (type === 'led' && !ledClear(s))) continue;
      const sl = place(type, s, side);
      if (sl) { if (ds || side !== side0) sl.status = 'moved'; return sl; }
    }
    return null;
  };
  const drop = (type: BillboardType, s: number, side: 1 | -1) => {
    route.alignment.sampleOffset(s, side * (H + 1.6 + SPEC[type].setback), f);
    dropped.push({ id: nextId++, type, format: TYPE_FORMAT[type], s, side, lat: 0, x: f.x, y: f.y, z: f.z, ry: 0, footY: f.y, region: route.regionIdAt(s / 1000), style: 'clean', status: 'dropped', dim: false, zone: [] });
  };

  // ---- roadside hoardings along the line ----
  const big = (st: StationInfo) => st.type === 'junction' || st.type === 'terminal';
  const nearStation = (s: number) => route.stations.find(st => st.type !== 'halt' && s > st.yardFromKm * 1000 - 1500 && s < st.yardToKm * 1000 + 1500);
  const freight = !!route.data.freight;
  const pick = <T,>(h: number, opts: [T, number][]) => { let x = h * opts.reduce((a, o) => a + o[1], 0); for (const [o, w] of opts) if ((x -= w) < 0) return o; return opts[opts.length - 1][0]; };
  let s = 400;
  while (s < L - 400) {
    const km = s / 1000, zone = route.zoneAt(km).zone, st = nearStation(s);
    const wild = WILD.has(zone) && !(route.data.billboardZones ?? []).includes(zone);
    const townish = zone === 'town' || zone === 'south-town' || zone === 'colony' || zone === 'village' || !!st;
    const perKm = wild ? 0 : settings.billboardsPerKm * (townish ? 1 : zone === 'industrial' || zone === 'terminal' ? 0.6 : 0.35);
    if (perKm <= 0) { s += 500; continue; }
    // no room inside station yards, on bridges or by tunnels: on past them (not a dropped billboard)
    const blockedBy = [...yards, ...structures].find(y => s > y.a && s < y.b);
    if (blockedBy) { s = blockedBy.b + 1; continue; }
    const h = hash2(Math.round(s), 17, 311), h2 = hash2(Math.round(s), 23, 313);
    const side: 1 | -1 = h < 0.5 ? -1 : 1;
    let type: BillboardType;
    if ((st && big(st) || zone === 'town' || zone === 'south-town') && leds < settings.ledPerRoute && h2 < 0.25) type = 'led';
    else if (st && big(st)) type = pick(h2, [['wide', 35], ['classic', 30], ['vshape', 15], ['rooftop', 20]]);
    else if (zone === 'town' || zone === 'south-town' || zone === 'colony') type = pick(h2, [['rooftop', 30], ['classic', 35], ['vshape', 20], ['wide', 15]]);
    else if (zone === 'village') type = pick(h2, [['wall', 50], ['classic', 40], ['vshape', 10]]);
    else if (zone === 'industrial' || zone === 'terminal' || freight) type = pick(h2, [['unipole', 50], ['wide', 30], ['classic', 20]]);
    else type = pick(h2, [['classic', 55], ['unipole', 25], ['vshape', 20]]);
    const sl = tryPlace(type, s, side);
    if (sl) {
      if (type === 'led') leds++;
      slots.push(sl);
    } else drop(type, s, side);
    s += (1000 / perKm) * (0.75 + hash2(Math.round(s), 29, 317) * 0.5);
  }
  // V-shaped hoardings: second face mirrored about the line's perpendicular (it reads for trains from the other way)
  for (const sl of slots) if (sl.type === 'vshape') {
    route.alignment.sample(sl.s, f);
    const perp = Math.atan2(-sl.side * -Math.sin(f.heading), -sl.side * Math.cos(f.heading)); // facing straight at the line
    sl.ry2 = 2 * perp - sl.ry;
  }

  // ---- small kiosks on the approaches to level crossings ----
  for (const lc of lcs) for (const side of [-1, 1] as const) {
    const s0 = lc - side * 70; // before the crossing for the trains this side faces
    if (s0 < 250 || s0 > L - 250 || !sameSideClear(s0, side)) continue;
    if (signals.some(sg => { const d = (s0 - sg.s) * sg.dir; return d > -200 && d < 30; })) continue;
    const sl = place('kiosk', s0, side);
    if (sl) slots.push(sl);
  }

  // ---- station platforms and foot over bridges (seen while standing at the platform / passing under) ----
  for (const st of route.stations) {
    if (st.type === 'halt') continue;
    for (const p of st.platforms) {
      if (p.lines.length !== 1) continue; // island platforms: tracks both sides
      const out = Math.sign(p.to - p.from), back = p.to - out * 0.45;
      const pf0 = st.platformFromKm, pf1 = st.platformToKm;
      for (const dk of [-0.17, -0.07, 0.07, 0.17]) {
        // between the platform lamps (every 25 m from the platform end)
        let km = st.km + dk;
        km = pf0 + 0.01 + 0.0125 + Math.round((km - pf0 - 0.0225) / 0.025) * 0.025;
        if (km < pf0 + 0.03 || km > pf1 - 0.03) continue;
        route.alignment.sampleOffset(km * 1000, back, f);
        const ry = Math.atan2(-out * -Math.sin(f.heading), -out * Math.cos(f.heading)); // facing the track
        const y = route.alignment.elevationAt(km) + PLATFORM_H;
        slots.push({ id: nextId++, type: 'platform', format: 'standard', s: km * 1000, side: out > 0 ? 1 : -1, lat: back, x: f.x, y, z: f.z, ry, footY: y, region: route.regionIdAt(km), style: 'clean', status: 'ok', dim: false, zone: [] });
      }
    }
    if (!big(st) || freight || st.platforms.length < 2) continue;
    // the FOB (Station.ts: across all platforms at km + 0.09, deck at rail + 8.4 m): a banner on each side
    const lats = st.platforms.flatMap(p => [p.from, p.to]);
    const lo = Math.min(...lats) + 1.6, hi2 = Math.max(...lats) - 1.6, km = st.km + 0.09;
    for (const face of [-1, 1] as const) {
      route.alignment.sampleOffset(km * 1000 + face * 1.75, (lo + hi2) / 2, f);
      const y = route.alignment.elevationAt(km) + RAIL_TOP + 8.4;
      const ry = Math.atan2(face * Math.cos(f.heading), face * Math.sin(f.heading));
      slots.push({ id: nextId++, type: 'fob', format: 'wide', s: km * 1000 + face, side: face, lat: (lo + hi2) / 2, x: f.x, y, z: f.z, ry, footY: y, region: route.regionIdAt(km), style: 'clean', status: 'ok', dim: false, zone: [] });
    }
  }

  const stats: PlanStats = { slots: slots.length, ok: slots.filter(x => x.status === 'ok').length, moved: slots.filter(x => x.status === 'moved').length, dropped: dropped.length, byType: {} };
  for (const sl of slots) stats.byType[sl.type] = (stats.byType[sl.type] ?? 0) + 1;
  return { slots, dropped, stats };
}

/** Convex hull (x,z pairs flattened), counter-clockwise. */
function hull(p: [number, number][]) {
  const pts = [...p].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [], upper: [number, number][] = [];
  for (const q of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (const q of [...pts].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)].flat();
}

/** Is (x, z) inside a convex polygon from hull()? */
export function inZone(poly: number[], x: number, z: number) {
  const n = poly.length / 2;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    const ax = poly[i * 2], az = poly[i * 2 + 1], bx = poly[((i + 1) % n) * 2], bz = poly[((i + 1) % n) * 2 + 1];
    if ((bx - ax) * (z - az) - (bz - az) * (x - ax) < 0) return false;
  }
  return true;
}
