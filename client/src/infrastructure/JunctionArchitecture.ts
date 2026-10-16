import * as THREE from 'three/webgpu';
import { GeoBatch, mat } from '../core/GeoBatch';
import { labelTexture } from '../core/Textures';
import { Strip } from '../track/TrackMeshBuilder';
import { newFrame, RAIL_TOP, TrackFrame } from '@rail/shared/track/Chainage';
import { deadEnds, LineDef, Switch } from '@rail/shared/track/TrackGraph';
import { rng } from '@rail/shared/util';
import type { Route, StationInfo } from '@rail/shared/track/Route';
import type { JunctionStyle } from '@rail/shared/track/Junctions';
import type { RoofCover } from './Station';
import { buildDravidian } from './DravidianJunction';

/** what the station view gives the junction builder */
export interface JunctionSite {
  route: Route; st: StationInfo; b: GeoBatch; group: THREE.Group; roofs: RoofCover[];
  /** station-local position (and heading) of a point on the line */
  at: (km: number, lat: number) => { x: number; y: number; z: number; ry: number; h: number };
  ox: number; oz: number;
  /** platform top above the alignment */
  pfH: number;
  /** every track as surveyed (both directions): the sidings are only in one direction's view */
  layout?: { lines: LineDef[]; switches: Switch[] };
  /** fittings shared with the ordinary platforms: hanging clock and speaker (q: local, platform top), live departure board */
  fit?: {
    clock(q: { x: number; y: number; z: number; ry: number }, ceil: number): void;
    speaker(q: { x: number; y: number; z: number; ry: number }, ceil: number, dir: number): void;
    board(m: THREE.Matrix4, w: number, h: number): void;
  };
  /** world positions of night lamps (the pooled lamp lights go to the nearest) */
  lamps?: THREE.Vector3[];
}

/** a station-frame placement: dx along the line, lat across, up from the alignment (rotations, scale) */
export type Place = (dx: number, lat: number, up: number, rx?: number, rz?: number, ry?: number, sx?: number, sy?: number, sz?: number) => THREE.Matrix4;

/** what a style module gets from the junction builder */
export interface JunctionKit {
  s: JunctionSite; b: GeoBatch; st: StationInfo;
  side: number; F: number; H: number; L0: number; L1: number;
  M: Place; bl: (d: number) => number;
  vault: (dx0: number, dx1: number, profile: [number, number][], color: string, key: string, closed?: boolean, swapUV?: boolean) => void;
  cover: (latMid: number, halfWid: number, halfLen: number, top: number) => void;
  sign: (dx: number, lat: number, up: number, w: number, h: number, bg: string, fg: string, back?: boolean) => void;
  clockAt: (dx: number, lat: number, up: number, scale: number) => ClockSpot;
}

/**
 * The two siding roads kept free of parked stock at a big junction because something moves on them:
 * the shunting road (the first yard road, else the outermost carriage siding) and the light-engine
 * road (the second shed road).
 */
export function movingRoads(code: string, lines: LineDef[]) {
  const mine = lines.filter(l => l.station === code).map(l => l.id);
  const cs = mine.filter(id => /-C\d+$/.test(id)).sort();
  return { shunt: mine.find(id => id === `${code}-Y1`) ?? cs[cs.length - 1], light: mine.find(id => id === `${code}-S2`) };
}

/** where the station clock goes (local), and how big */
export interface ClockSpot { x: number; y: number; z: number; ry: number; scale: number }

/** how far the big roof / train shed reaches each way from the station centre (m) */
export const JUNCTION_ROOF_HALF = { modern: 200, colonial: 170 } as const;

const _q = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0), _d = new THREE.Vector3();

/**
 * The architecture of the three big junctions, one style each, all built of
 * merged primitives (a handful of draws per station, streamed with it):
 *  - modern (Navyug): a white wave roof over every platform on tree columns,
 *    a glazed air concourse across the tracks, a glass-and-fin terminal;
 *  - rajasthani (Rajmahal): a sandstone palace front with a cusped arcade,
 *    jharokhas, chhatris, a central dome, corner towers, clock tower, fountain;
 *  - colonial: an Indo-Saracenic brick-and-stone terminus with domes,
 *    turrets, gables and a clock tower, an iron arched train shed over the
 *    platforms, a plinthed steam loco and palms in the forecourt (no station
 *    uses it now; kept for a future one);
 *  - dravidian (Sagarpur): DravidianJunction.ts.
 * Positions are in the station frame: dx metres along the line from the
 * centre, lat metres across (+ right), up metres above the alignment.
 */
export function buildJunction(style: JunctionStyle, s: JunctionSite): ClockSpot {
  const { st, b } = s;
  const side = st.buildingSide;
  const lats = st.platforms.flatMap(p => [p.from, p.to]);
  const L0 = Math.min(...lats), L1 = Math.max(...lats);
  const outer = side > 0 ? L1 : -L0;
  const F = outer + 4; // building front, from the track centre
  const H = s.pfH;
  const M = (dx: number, lat: number, up: number, rx = 0, rz = 0, ry = 0, sx = 1, sy = 1, sz = 1) => {
    const q = s.at(st.km + dx / 1000, lat);
    return mat(q.x, q.y + up, q.z, q.ry + ry, rx, rz, sx, sy, sz);
  };
  /** lateral distance d out from the building front (towards the road) */
  const bl = (d: number) => side * (F + d);
  /** a round bar between two station-frame points [dx, lat, up] */
  const rod = (a: number[], c: number[], r: number, color: string, key = 'metal', seg = 5) => {
    _d.set(c[0] - a[0], c[2] - a[2], c[1] - a[1]);
    const len = _d.length();
    if (len < 1e-3) return;
    _q.setFromUnitVectors(_up, _d.normalize());
    const m = M((a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2).multiply(new THREE.Matrix4().makeRotationFromQuaternion(_q));
    b.cyl(r, r, len, seg, m, color, key);
  };
  const dome = (dx: number, lat: number, up: number, r: number, color: string, sy = 1, key = 'std') =>
    b.add(DOME_GEO, M(dx, lat, up, 0, 0, 0, r, r * sy, r), color, key);
  const finial = (dx: number, lat: number, up: number, h: number, color = '#c9a64a') => b.add(CONE_GEO, M(dx, lat, up + h / 2, 0, 0, 0, h * 0.12, h, h * 0.12), color, 'metal');
  /** a small domed pavilion on four pillars (Rajasthani roofline) */
  const chhatri = (dx: number, lat: number, up: number, w: number, stone: string, domeCol: string) => {
    b.box(w + 0.4, 0.3, w + 0.4, M(dx, lat, up + 0.15), stone, 'std');
    for (const [a, c] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) b.box(0.25, w * 0.9, 0.25, M(dx + a * w / 2, lat + c * w / 2, up + 0.3 + w * 0.45), stone, 'std');
    b.box(w + 0.7, 0.25, w + 0.7, M(dx, lat, up + 0.42 + w * 0.9), stone, 'std');
    dome(dx, lat, up + 0.55 + w * 0.9, w * 0.55, domeCol, 1.15);
    finial(dx, lat, up + 0.55 + w * 0.9 + w * 0.62, 0.9);
  };
  /** an arch outline (half ring) in the plane facing across the line */
  const arch = (dx: number, lat: number, up: number, r: number, tube: number, color: string, key = 'std') =>
    b.add(ARCH_GEO, M(dx, lat, up, 0, 0, 0, r, r, tube / 0.1), color, key);
  /** extrude a cross-section profile (lat, up) along the line over [dx0, dx1] into the batch (swapUV: texture v across the profile) */
  const vault = (dx0: number, dx1: number, profile: [number, number][], color: string, key: string, closed = false, swapUV = false) => {
    const frames: TrackFrame[] = [], ss: number[] = [], f = newFrame();
    for (let dx = dx0; dx <= dx1 + 1e-6; dx += 20) {
      s.route.alignment.sample((st.km * 1000) + dx, f);
      frames.push({ ...f, cant: 0 });
      ss.push(dx - dx0);
    }
    const strip = new Strip();
    strip.extrude(frames, ss, profile, s.ox, s.oz, 1, 1, closed);
    if (swapUV) for (let i = 0; i < strip.uv.length; i += 2) { const u = strip.uv[i]; strip.uv[i] = strip.uv[i + 1]; strip.uv[i + 1] = u; }
    b.add(strip.geometry(), null, color, key);
  };
  const cover = (latMid: number, halfWid: number, halfLen: number, top: number) => {
    const f = newFrame();
    s.route.alignment.sampleOffset(st.km * 1000, latMid, f);
    s.roofs.push({ x: f.x, z: f.z, cos: Math.cos(f.heading), sin: Math.sin(f.heading), halfLen, halfWid, top: f.y + top });
  };
  /** a big lit sign (station name) facing the platforms (or, `back`, the road) */
  const sign = (dx: number, lat: number, up: number, w: number, h: number, bg: string, fg: string, back = false) => {
    const t = labelTexture(`${st.name}|jn-${style}`, { bg, fg, w: 1024, h: 160, lines: [`${st.nameHi}   ${st.name.toUpperCase()}   ${st.nameRegional}`] });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: t, roughness: 0.5, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.25 }));
    const q = s.at(st.km + dx / 1000, lat);
    m.position.set(q.x, q.y + up, q.z);
    m.rotation.y = q.ry + ((side > 0) !== back ? Math.PI : 0);
    s.group.add(m);
  };
  /** the clock on the platform-facing wall at lateral `lat` */
  const clockAt = (dx: number, lat: number, up: number, scale: number): ClockSpot => {
    const q = s.at(st.km + dx / 1000, lat);
    return { x: q.x, y: q.y + up, z: q.z, ry: q.ry + (side > 0 ? Math.PI : 0), scale };
  };
  // the platform each column row stands on: island middles, and near the back of the outer side platforms
  const rows = st.platforms.map(p => {
    const lo = Math.min(p.from, p.to), hi = Math.max(p.from, p.to);
    return hi === L1 && p.lines.length === 1 ? hi - 1.5 : lo === L0 && p.lines.length === 1 ? lo + 1.5 : (lo + hi) / 2;
  }).sort((a, c) => a - c);

  depot();
  if (style === 'dravidian') return buildDravidian({ s, b, st, side, F, H, L0, L1, M, bl, vault, cover, sign, clockAt });
  // the live departure board on the building's platform face
  s.fit?.board(M(30, bl(-0.4), H + 3.2, 0, 0, side > 0 ? Math.PI : 0), 6, 2.4);
  if (style === 'modern') return modern();
  if (style === 'rajasthani') return rajasthani();
  return colonial();

  // ------------------------------------------- loco shed, carriage sidings, goods yard
  /**
   * What stands in the sidings (each a dead end): rakes of coaches in the carriage sidings,
   * goods wagons on most yard roads, electric locos under a two-road shed at the end of the shed roads.
   */
  function depot() {
    if (!s.layout) return;
    const r = rng(Math.floor(st.km * 1000) + 17);
    const ends = deadEnds(s.layout.lines, s.layout.switches, s.route.lengthKm);
    const mine = s.layout.lines.filter(l => l.station === st.code && /-[CSY]\d+$/.test(l.id));
    const R = RAIL_TOP;
    const bogies = (dx: number, lat: number, half: number) => { for (const e of [-1, 1]) b.box(3.0, 0.8, 2.5, M(dx + e * half, lat, R + 0.5), '#222222', 'metal'); };
    const shed: { dx: number; dir: number; lat: number; light: boolean }[] = [];
    const moving = movingRoads(st.code, s.layout.lines);
    for (const l of mine) {
      const e = ends.find(d => d.line === l.id);
      if (!e) continue;
      const kind = /-([CSY])\d+$/.exec(l.id)![1], dir = e.dir;
      const endDx = (e.km - st.km) * 1000 - dir * 8, room = (l.toKm - l.fromKm) * 1000 - 70;
      const lat = l.offset;
      if (kind === 'S') { shed.push({ dx: endDx, dir, lat, light: l.id === moving.light }); continue; }
      if (l.id === moving.shunt) continue; // the shunter works this road
      if (kind === 'C') {
        // a passenger rake: ICF blue with a cream band, or LHB red with grey
        const icf = r() < 0.5, body = icf ? '#2c5aa0' : '#a33a32', band = icf ? '#f1e3b5' : '#c9c9c9';
        const n = Math.min(20, Math.floor((room * (0.6 + r() * 0.3)) / 23.5));
        for (let i = 0; i < n; i++) {
          const dx = endDx - dir * (i * 23.5 + 11.75);
          b.box(22.7, 3.1, 3.2, M(dx, lat, R + 2.65), body, 'metal');
          b.box(22.72, 0.75, 3.24, M(dx, lat, R + 3.0), '#22303a', 'metal');
          b.box(22.74, 0.18, 3.22, M(dx, lat, R + 2.1), band, 'metal');
          b.box(22.6, 0.25, 2.9, M(dx, lat, R + 4.3), '#9aa0a3', 'metal');
          bogies(dx, lat, 7.6);
        }
      } else if (kind === 'Y') {
        if (r() < 0.3) continue; // an empty road
        const n = Math.min(45, Math.floor((room * (0.5 + r() * 0.4)) / 10.7)), loaded = r() < 0.6;
        for (let i = 0; i < n; i++) {
          const dx = endDx - dir * (i * 10.7 + 5.35);
          b.box(9.9, 2.3, 3.1, M(dx, lat, R + 2.2), '#6b3d2a', 'metal');
          b.box(9.5, 0.06, 2.8, M(dx, lat, R + 3.1 + (loaded ? 0.15 : -1.0)), loaded ? '#1d1d1d' : '#3a2a20', 'std');
          bogies(dx, lat, 3.3);
        }
      }
    }
    if (!shed.length) return;
    // the loco shed: a gabled steel shed over both roads at their end, a low wall along each side, locos inside
    const dir = shed[0].dir, d0 = shed[0].dx, d1 = d0 - dir * 110;
    const lo = Math.min(...shed.map(x => x.lat)) - 4.5, hi = Math.max(...shed.map(x => x.lat)) + 4.5, mid = (lo + hi) / 2;
    vault(Math.min(d0, d1), Math.max(d0, d1), [[hi + 1, R + 8.6], [mid, R + 11], [lo - 1, R + 8.6], [lo - 1, R + 8.4], [mid, R + 10.8], [hi + 1, R + 8.4]], '#ffffff', 'sheet', true);
    for (let k = 0; k <= 11; k++) {
      const dx = d0 - dir * k * 10;
      for (const l of [lo, hi]) b.box(0.4, 8.6, 0.4, M(dx, l, R + 4.3), '#5d6770', 'metal');
      if (k < 11) for (const l of [lo, hi]) b.box(10, 3, 0.3, M(dx - dir * 5, l, R + 1.5), '#c9b9a0', 'std');
    }
    for (const l of [lo, hi]) b.box(110, 0.4, 0.4, M((d0 + d1) / 2, l, R + 8.4), '#5d6770', 'metal');
    const liveries = [['#b8322c', '#efefef'], ['#2d5f9a', '#f2c230'], ['#c8102e', '#f2f2f2']];
    for (const x of shed) for (let i = 0; i < 2; i++) {
      if (r() < 0.25 || x.light) continue; // (the light engine comes and goes on its road)
      const [body, band] = liveries[Math.floor(r() * liveries.length)];
      const dx = x.dx - x.dir * (12 + i * 22);
      b.box(19.8, 3.3, 3.1, M(dx, x.lat, R + 2.95), body, 'metal');
      b.box(19.82, 0.35, 3.12, M(dx, x.lat, R + 2.3), band, 'metal');
      for (const e of [-1, 1]) b.box(0.1, 0.9, 2.3, M(dx + e * 9.92, x.lat, R + 3.9), '#1b2530', 'metal');
      b.box(9, 0.45, 1.8, M(dx, x.lat, R + 4.8), '#8d9499', 'metal');
      bogies(dx, x.lat, 6.4);
    }
  }

  // ------------------------------------------------------------------ Navyug
  function modern(): ClockSpot {
    const half = JUNCTION_ROOF_HALF.modern;
    // wave roof: white sheet, one wave per bay of columns, eaves 15 m over the platforms; skylights along the crests
    const a = L0 - 3, c = L1 + 3, W = c - a, waves = Math.max(3, Math.round(W / 26)), E = H + 15, R = 3.5, n = waves * 10;
    const y = (lat: number) => E + R * Math.sin(Math.PI * (((lat - a) / W) * waves % 1));
    const topP: [number, number][] = [], under: [number, number][] = [];
    for (let k = 0; k <= n; k++) { const lat = c - (W * k) / n; topP.push([lat, y(lat)]); }
    for (let k = n; k >= 0; k--) { const lat = c - (W * k) / n; under.push([lat, y(lat) - 0.45]); }
    vault(-half, half, [...topP, ...under], '#f2f4f5', 'std', true);
    for (let w = 0; w < waves; w++) {
      const cl = a + (W * (w + 0.5)) / waves;
      vault(-half, half, [[cl + 1.8, E + R + 0.08], [cl - 1.8, E + R + 0.08]], '#bfe3f0', 'glass');
    }
    cover((a + c) / 2, W / 2, half, E - 0.5);
    // tree columns on every platform: a trunk branching into four arms that hold the roof
    for (const lat of rows) for (let dx = -half + 18; dx <= half - 18; dx += 36) {
      b.cyl(0.32, 0.42, 9, 8, M(dx, lat, H + 4.5), '#e9ecee', 'metal');
      for (const [ax, al] of [[-4, -3.5], [4, -3.5], [-4, 3.5], [4, 3.5]]) rod([dx, lat, H + 9], [dx + ax, lat + al, y(lat + al) - 0.45], 0.16, '#e9ecee');
    }
    // air concourse: a glazed deck over all the tracks, from the far side to the terminal, escalators down to every platform
    const cx = 110, cl = 36, d0 = L0 - 3, d1 = side > 0 ? F + 2 : -F - 2, lo = Math.min(d0, d1, L0 - 3), hi = Math.max(L1 + 3, d1);
    const mid = (lo + hi) / 2, span = hi - lo, deck = H + 8;
    b.box(cl, 0.8, span, M(cx, mid, deck), '#eceff1', 'concrete');
    b.box(cl + 2, 0.6, span + 2, M(cx, mid, deck + 6.6), '#f4f6f7', 'metal');
    for (const e of [-1, 1]) {
      b.box(0.12, 6, span, M(cx + e * cl / 2, mid, deck + 3.4), '#9fd2e6', 'glass');
      for (let l = lo; l <= hi; l += 4) b.box(0.18, 6, 0.14, M(cx + e * (cl / 2 + 0.05), l, deck + 3.4), '#f4f6f7', 'metal');
      b.box(0.3, 0.3, span, M(cx + e * (cl / 2 + 0.05), mid, deck + 0.55), '#f4f6f7', 'metal');
    }
    for (const lat of rows) {
      b.box(5, deck - H, 3, M(cx, lat, H + (deck - H) / 2), '#e3e7ea', 'concrete'); // lift core
      const run = 18, ang = Math.atan2(deck - H, run);
      const inw = lat > 0 ? -1 : 1; // escalators on the side towards the centre (side platforms: their only side)
      b.box(Math.hypot(run, deck - H), 0.5, 1.8, M(cx - cl / 2 - run / 2, lat + inw * 2.2, H + (deck - H) / 2, 0, ang), '#cfd6db', 'metal');
      b.box(Math.hypot(run, deck - H), 1.0, 0.08, M(cx - cl / 2 - run / 2, lat + inw * 3.1, H + (deck - H) / 2 + 0.7, 0, ang), '#9fd2e6', 'glass');
    }
    // terminal: dark body behind a glass curtain wall, white floor bands and vertical fins, a floating roof
    const len = 170, dep = 30, ht = 18, bc = bl(dep / 2);
    b.box(len, ht + 4, dep, M(0, bc, H + ht / 2 - 2), '#34495e', 'std');
    for (const face of [0, dep]) {
      b.box(len - 2, ht - 1.5, 0.2, M(0, bl(face - (face ? -0.12 : 0.12)), H + ht / 2 - 0.5), '#86b9d6', 'glass');
      for (let dx = -len / 2 + 2; dx <= len / 2 - 2; dx += 4) b.box(0.25, ht + 0.5, 0.9, M(dx, bl(face + (face ? 0.45 : -0.45)), H + ht / 2), '#e6e9ea', 'metal');
    }
    for (const fl of [4.5, 9, 13.5]) b.box(len + 0.4, 0.35, dep + 0.4, M(0, bc, H + fl), '#f4f6f7', 'std');
    b.box(len + 16, 0.8, dep + 14, M(0, bc, H + ht + 0.4), '#f4f6f7', 'metal');
    b.box(len + 16, 0.5, 0.4, M(0, bl(-7), H + ht + 0.95), '#c0c7cc', 'metal');
    // entrance canopy on the road side
    b.box(56, 0.5, 14, M(0, bl(dep + 7), H + 7), '#f4f6f7', 'metal');
    for (let dx = -26; dx <= 26; dx += 13) b.cyl(0.25, 0.25, 7, 8, M(dx, bl(dep + 13), H + 3.5), '#e6e9ea', 'metal');
    // forecourt
    b.box(200, 0.3, 40, M(0, bl(dep + 20), 0.05), '#b9b4aa', 'concrete');
    sign(0, bl(-0.2), H + ht + 3.2, 70, 6, '#0b3d63', '#ffffff');
    sign(0, bl(dep + 0.2), H + ht + 3.2, 70, 6, '#0b3d63', '#ffffff', true);
    b.box(72, 6.4, 0.3, M(0, bl(0.05), H + ht + 3.2), '#0b3d63', 'metal');
    return clockAt(-40, bl(-0.4), H + 11, 2.2);
  }

  // ---------------------------------------------------------------- Rajmahal
  function rajasthani(): ClockSpot {
    const sand = '#d99a5b', light = '#efcf9f', marble = '#f5ebdc', deep = '#c47f45';
    const len = 200, dep = 22, ht = 10;
    // two storeys of sandstone, a string course between, a crenellated parapet
    b.box(len, ht + 4, dep, M(0, bl(dep / 2), H + ht / 2 - 2), sand, 'std');
    b.box(len + 1, 0.5, dep + 1, M(0, bl(dep / 2), H + 5.2), deep, 'std');
    b.box(len + 0.6, 1.0, dep + 0.6, M(0, bl(dep / 2), H + ht + 0.5), light, 'std');
    for (let dx = -len / 2 + 1; dx <= len / 2 - 1; dx += 2.2) b.box(1.1, 0.8, 0.6, M(dx, bl(0), H + ht + 1.4), light, 'std');
    // cusped arcade (verandah) along the platform face
    const vl = bl(-3.6);
    for (let dx = -len / 2 + 2; dx <= len / 2 - 2; dx += 4) {
      b.box(0.7, 4.6, 0.7, M(dx, vl, H + 2.3), light, 'std');
      if (dx + 4 <= len / 2 - 2) arch(dx + 2, vl, H + 3.0, 1.65, 0.22, light);
    }
    b.box(len, 0.9, 4.6, M(0, bl(-2.1), H + 5.0), sand, 'std');
    // jharokhas on the upper storey: projecting balconies with domed hoods
    const tx = -40, tw = 7, th = 30; // the clock tower (below)
    for (let dx = -len / 2 + 8; dx <= len / 2 - 8; dx += 10) {
      if (Math.abs(dx) < 24 || Math.abs(dx - tx) < 9) continue;
      b.box(2.8, 2.0, 1.3, M(dx, bl(-0.65), H + 7.3), light, 'std');
      b.box(1.9, 1.4, 0.05, M(dx, bl(-1.32), H + 7.4), '#3a2a20', 'std');
      b.box(3.4, 0.16, 1.8, M(dx, bl(-0.8), H + 8.4), deep, 'std');
      dome(dx, bl(-0.7), H + 8.45, 1.1, marble, 0.8);
      for (const e of [-1, 1]) b.box(0.25, 0.6, 1.0, M(dx + e * 1.1, bl(-0.6), H + 6.0), deep, 'std');
      // arched windows either side
      for (const e of [-1, 1]) b.box(1.1, 1.8, 0.05, M(dx + e * 4, bl(-0.03), H + 7.4), '#3a2a20', 'std');
    }
    // chhatris along the roof edge
    for (let dx = -len / 2 + 12; dx <= len / 2 - 12; dx += 20) if (Math.abs(dx) > 26) chhatri(dx, bl(1.6), H + ht + 1, 2.6, light, marble);
    // centre: a taller block with a great dome on a drum and four chhatris
    const cw = 40, cd = dep + 8, ch = 18, cc = bl(cd / 2);
    b.box(cw, ch + 4, cd, M(0, cc, H + ch / 2 - 2), sand, 'std');
    b.box(cw + 1, 1.0, cd + 1, M(0, cc, H + ch + 0.5), light, 'std');
    arch(0, bl(-0.05), H + 6, 5, 0.5, light);
    b.box(9.4, 6, 0.1, M(0, bl(-0.08), H + 3), '#3a2a20', 'std');
    b.cyl(8, 8, 4, 16, M(0, cc, H + ch + 3), light, 'std');
    dome(0, cc, H + ch + 5, 8.4, marble, 0.95);
    finial(0, cc, H + ch + 5 + 8, 3);
    for (const [a, c] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) chhatri(a * (cw / 2 - 3), cc + c * (cd / 2 - 3), H + ch + 1, 3.2, light, marble);
    // round towers at the ends
    for (const e of [-1, 1]) {
      b.cyl(4.2, 4.8, ht + 8, 14, M(e * len / 2, bl(dep / 2), H + (ht + 8) / 2 - 1), sand, 'std');
      b.cyl(4.6, 4.6, 0.8, 14, M(e * len / 2, bl(dep / 2), H + ht + 6.6), light, 'std');
      dome(e * len / 2, bl(dep / 2), H + ht + 7, 4.2, marble, 1.1);
      finial(e * len / 2, bl(dep / 2), H + ht + 11.6, 1.6);
    }
    // clock tower rising from the front, west of the centre block
    b.box(tw, th + 4, tw, M(tx, bl(tw / 2), H + th / 2 - 2), sand, 'std');
    for (const up of [10, 20]) b.box(tw + 0.6, 0.5, tw + 0.6, M(tx, bl(tw / 2), H + up), deep, 'std');
    b.box(tw + 1, 0.8, tw + 1, M(tx, bl(tw / 2), H + th + 0.4), light, 'std');
    chhatri(tx, bl(tw / 2), H + th + 0.8, tw - 1.6, light, marble);
    // fountain in the forecourt
    const fl = bl(dep + 30);
    b.box(160, 0.3, 50, M(0, bl(dep + 25), 0.05), '#d8c3a0', 'std');
    b.cyl(9, 9.4, 0.9, 28, M(0, fl, 0.45), sand, 'std');
    b.cyl(8.5, 8.5, 0.1, 28, M(0, fl, 0.8), '#5fa8d3', 'glass');
    b.cyl(0.7, 1.0, 2.6, 10, M(0, fl, 1.3), light, 'std');
    b.cyl(3.0, 1.2, 0.5, 16, M(0, fl, 2.7), light, 'std');
    b.cyl(0.4, 0.6, 1.6, 10, M(0, fl, 3.6), light, 'std');
    b.cyl(1.4, 0.6, 0.35, 12, M(0, fl, 4.4), light, 'std');
    for (const e of [-1, 1]) for (let k = 0; k < 6; k++) b.cyl(0.6, 0.8, 1.2, 8, M(e * (14 + k * 12), bl(dep + 6), 0.6), deep, 'std'); // planters
    sign(0, bl(-0.15), H + ch - 3, 34, 3.4, '#7a1f1f', '#fbe7b2');
    sign(0, bl(cd + 0.15), H + ch - 3, 34, 3.4, '#7a1f1f', '#fbe7b2', true);
    return clockAt(tx, bl(-0.05), H + 24, 2);
  }

  // ---------------------------------------------------------------- Sagarpur
  function colonial(): ClockSpot {
    const half = JUNCTION_ROOF_HALF.colonial;
    const brick = '#b4583c', cream = '#eadfc6', copper = '#6f9a86', iron = '#3f4a52';
    // iron train shed: an arched span between each pair of column rows, ribs every 12 m, a glazed crown
    const spring = H + 8, cols = rows;
    for (let i = 0; i + 1 < cols.length; i++) {
      const a = cols[i], c = cols[i + 1], w = c - a, rise = w * 0.3, n = 14;
      const y = (t: number) => spring + rise * Math.sin(Math.PI * t);
      const topP: [number, number][] = [], under: [number, number][] = [];
      for (let k = 0; k <= n; k++) topP.push([c - (w * k) / n, y(1 - k / n)]);
      for (let k = n; k >= 0; k--) under.push([c - (w * k) / n, y(1 - k / n) - 0.12]);
      vault(-half, half, [...topP, ...under], '#8a9399', 'metal', true);
      vault(-half, half, [0.62, 0.56, 0.5, 0.44, 0.38].map(t => [a + w * t, y(t) + 0.1] as [number, number]), '#cfe3ea', 'glass');
      cover((a + c) / 2, w / 2, half, spring);
      for (let dx = -half; dx <= half; dx += 12) {
        for (let k = 0; k < 10; k++) rod([dx, a + (w * k) / 10, y(k / 10) - 0.35], [dx, a + (w * (k + 1)) / 10, y((k + 1) / 10) - 0.35], 0.14, iron, 'metal', 4);
        rod([dx, a, spring - 0.2], [dx, c, spring - 0.2], 0.05, iron, 'metal', 4); // tie
      }
      for (const t of [0.25, 0.5, 0.75]) rod([-half, a + w * t, y(t) - 0.4], [half, a + w * t, y(t) - 0.4], 0.1, iron, 'metal', 4); // purlins
    }
    for (const lat of cols) for (let dx = -half; dx <= half; dx += 12) {
      b.cyl(0.2, 0.28, spring - H, 8, M(dx, lat, H + (spring - H) / 2), iron, 'metal');
      b.box(0.9, 0.45, 0.9, M(dx, lat, spring - 0.1), iron, 'metal');
      b.box(0.6, 0.3, 0.6, M(dx, lat, H + 0.15), iron, 'metal');
    }
    // the terminus: red brick with cream stone bands, an arcade to the platforms, pointed windows, gables
    const len = 220, dep = 24, ht = 18;
    b.box(len, ht + 4, dep, M(0, bl(dep / 2), H + ht / 2 - 2), brick, 'brick');
    for (const up of [6, 12]) b.box(len + 0.6, 0.6, dep + 0.6, M(0, bl(dep / 2), H + up), cream, 'std');
    b.box(len + 1.4, 1.0, dep + 1.4, M(0, bl(dep / 2), H + ht + 0.3), cream, 'std');
    const vl = bl(-3.6);
    for (let dx = -len / 2 + 2; dx <= len / 2 - 2; dx += 4.5) {
      b.box(0.8, 4.8, 0.8, M(dx, vl, H + 2.4), cream, 'std');
      if (dx + 4.5 <= len / 2 - 2) arch(dx + 2.25, vl, H + 3.4, 1.85, 0.22, cream);
    }
    b.box(len, 0.8, 4.6, M(0, bl(-2.1), H + 5.4), brick, 'brick');
    for (let dx = -len / 2 + 4.5; dx <= len / 2 - 4.5; dx += 4.5) {
      if (Math.abs(dx) < 24) continue;
      for (const up of [8.6, 14.6]) {
        b.box(1.5, 2.4, 0.08, M(dx, bl(-0.04), H + up), '#2c2a28', 'std');
        b.box(2.0, 0.25, 0.3, M(dx, bl(-0.15), H + up - 1.3), cream, 'std');
        arch(dx, bl(-0.08), H + up + 1.15, 0.78, 0.13, cream);
      }
    }
    // gables along the roof (a square turned 45 degrees, half in the roof) and turrets at the corners
    for (let dx = -len / 2 + 22; dx <= len / 2 - 22; dx += 44) if (Math.abs(dx) > 30) b.box(6, 6, 1.4, M(dx, bl(0.4), H + ht + 0.6, 0, Math.PI / 4), brick, 'brick');
    const turret = (dx: number, lat: number, top: number) => {
      b.cyl(1.5, 1.6, top + 4, 8, M(dx, lat, H + top / 2 - 2), cream, 'std');
      dome(dx, lat, H + top, 1.7, copper, 1.3);
      finial(dx, lat, H + top + 2.1, 1.2);
    };
    for (const e of [-1, 1]) for (const d of [0, dep]) turret(e * len / 2, bl(d), ht + 4);
    // centre block: great ribbed dome on an octagonal drum
    const cw = 44, cd = dep + 6, ch = 26, cc = bl(cd / 2);
    b.box(cw, ch + 4, cd, M(0, cc, H + ch / 2 - 2), brick, 'brick');
    for (const up of [6, 12, 18]) b.box(cw + 0.6, 0.6, cd + 0.6, M(0, cc, H + up), cream, 'std');
    b.box(cw + 1.4, 1.0, cd + 1.4, M(0, cc, H + ch + 0.3), cream, 'std');
    b.cyl(9, 9.5, 5, 8, M(0, cc, H + ch + 2.8), cream, 'std');
    dome(0, cc, H + ch + 5.2, 9.5, copper, 1.15);
    finial(0, cc, H + ch + 16, 4, '#d6b14d');
    for (const [a, c] of [[-1, 0], [1, 0], [-1, cd], [1, cd]]) turret(a * cw / 2, bl(c), ch + 4);
    // clock tower on the platform face of the centre block, a pyramid spire
    const tw = 8, th = 36, tl = bl(tw / 2 - 2);
    b.box(tw, th + 4, tw, M(0, tl, H + th / 2 - 2), brick, 'brick');
    for (const up of [12, 24, th]) b.box(tw + 0.8, 0.6, tw + 0.8, M(0, tl, H + up), cream, 'std');
    b.add(SPIRE_GEO, M(0, tl, H + th + 4.5, 0, 0, Math.PI / 4, tw * 0.75, 9, tw * 0.75), copper, 'metal');
    for (const [a, c] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) turret(a * tw / 2, tl + c * tw / 2, th + 2);
    // forecourt: paving, palms, the old steam loco on its plinth
    const fc = bl(cd + 22);
    b.box(240, 0.3, 40, M(0, fc, 0.05), '#cfc6b2', 'stone');
    for (const e of [-1, 1]) for (let k = 0; k < 7; k++) palm(b, M, e * (30 + k * 14), bl(dep + 4 + (k % 2) * 2), 7 + (k % 3));
    for (let k = 0; k < 6; k++) palm(b, M, -100 + k * 40, bl(cd + 40), 8 + (k % 2) * 2);
    steamLoco(b, M, 50, fc);
    sign(0, bl(-0.15), H + 21, 36, 3.4, '#1d3557', '#f6eedb');
    sign(0, bl(cd + 0.15), H + 21, 36, 3.4, '#1d3557', '#f6eedb', true);
    return clockAt(0, bl(-2.05), H + 30, 2.6);
  }
}


/** a coconut palm: a slightly leaning trunk and a crown of drooping fronds */
export function palm(b: GeoBatch, M: Place, dx: number, lat: number, h: number) {
  const lean = ((dx * 7 + lat * 3) % 5) * 0.02;
  b.cyl(0.17, 0.27, h, 6, M(dx, lat, h / 2, lean), '#7a6248', 'std');
  const top = M(dx, lat + Math.sin(lean) * h / 2, h);
  for (let k = 0; k < 8; k++) b.box(4.2, 0.05, 0.9, top.clone().multiply(mat(0, 0, 0, (k / 8) * Math.PI * 2, 0, -0.42)).multiply(mat(1.9, 0, 0)), k % 2 ? '#3f7d3a' : '#4d8c3f');
}

/** a broad gauge steam loco and tender, plinthed (black, red buffer beam and wheels, green cab) */
function steamLoco(b: GeoBatch, M: Place, dx: number, lat: number) {
  b.box(22, 1.2, 4.4, M(dx, lat, 0.6), '#d8cfbd', 'stone');
  for (const e of [-0.84, 0.84]) b.box(22, 0.17, 0.08, M(dx, lat + e, 1.3), '#8a8580', 'metal');
  const blk = '#1c1c1c', red = '#a8322a';
  b.cyl(0.95, 0.95, 7.2, 16, M(dx + 1.5, lat, 3.4, 0, Math.PI / 2), blk, 'metal'); // boiler
  b.cyl(1.05, 1.05, 1.2, 16, M(dx + 5.6, lat, 3.4, 0, Math.PI / 2), '#2a2a2a', 'metal'); // smokebox
  b.cyl(0.3, 0.36, 1.3, 10, M(dx + 5.6, lat, 4.9), blk, 'metal'); // chimney
  b.cyl(0.42, 0.5, 0.7, 10, M(dx + 2.4, lat, 4.6), '#b08d3a', 'metal'); // dome
  b.box(13, 0.15, 3.0, M(dx + 1, lat, 2.35), blk, 'metal'); // running plate
  b.box(0.3, 0.7, 3.0, M(dx + 6.5, lat, 1.9), red, 'metal'); // buffer beam
  b.box(3.0, 2.8, 3.1, M(dx - 3.3, lat, 3.7), '#2f5b3a', 'metal'); // cab
  b.box(3.4, 0.15, 3.3, M(dx - 3.3, lat, 5.15), blk, 'metal');
  for (const wx of [-1.2, 0.7, 2.6]) for (const e of [-0.95, 0.95]) b.cyl(0.85, 0.85, 0.14, 18, M(dx + wx, lat + e, 2.15, Math.PI / 2), red, 'metal');
  for (const e of [-1, 1]) b.box(4.0, 0.12, 0.08, M(dx + 0.7, lat + e * 1.05, 2.15), '#8a8580', 'metal'); // coupling rods
  b.box(5.8, 2.6, 3.0, M(dx - 8.0, lat, 3.0), blk, 'metal'); // tender
  for (const wx of [-9.8, -8.0, -6.2]) for (const e of [-0.95, 0.95]) b.cyl(0.5, 0.5, 0.12, 14, M(dx + wx, lat + e, 1.8, Math.PI / 2), red, 'metal');
}

const DOME_GEO = new THREE.SphereGeometry(1, 14, 7, 0, Math.PI * 2, 0, Math.PI / 2);
const CONE_GEO = new THREE.ConeGeometry(1, 1, 8);
/** half ring of radius 1 (tube 0.1), in the plane along the line (x) and up (y) */
const ARCH_GEO = new THREE.TorusGeometry(1, 0.1, 5, 12, Math.PI);
/** four-sided pyramid, height 1, base radius 1 */
const SPIRE_GEO = new THREE.ConeGeometry(1, 1, 4);
