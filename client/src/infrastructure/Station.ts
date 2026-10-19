import * as THREE from 'three/webgpu';
import { GeoBatch, mat } from '../core/GeoBatch';
import { labelTexture } from '../core/Textures';
import { materials } from '../core/Materials';
import { rng } from '@rail/shared/util';
import { newFrame, RAIL_TOP, TrackFrame } from '@rail/shared/track/Chainage';
import { Strip } from '../track/TrackMeshBuilder';
import type { Route, StationInfo } from '@rail/shared/track/Route';
import { Crowd } from '../world/people/Crowd';
import { buildJunction, ClockSpot } from './JunctionArchitecture';
import { FOB, fobKm, fobSpan } from './fobLayout';
import { addWaterStalls, STALL_HALF } from './WaterStall';
import type { LineDef, Switch } from '@rail/shared/track/TrackGraph';

/** Platform surface above formation level (high-level platform, 760 mm above rail). */
export const PLATFORM_H = RAIL_TOP + 0.76;
/** Width of the textured edge strip on the platform top (yellow line, tactile band). */
const EDGE_W = 1.6;
/** Bottom of the visible platform face (below it the ballast covers the wall). */
const FACE_BOTTOM = 0.55;
/** v (0..1 in the edge texture) where the vertical face ends and the top begins. */
const FACE_V = 0.18;

/**
 * Platform edge strip: the top within EDGE_W of the edge plus the vertical
 * face, with u along the platform in metres and v across: 0 at the face
 * bottom, FACE_V at the edge, 1 at the inner end of the strip (the texture is
 * tile-x: it repeats along the platform only).
 */
function edgeStrip(frames: TrackFrame[], ss: number[], a: number, sg: number, ox: number, oz: number, sizeV: number) {
  const prof: [number, number, number][] = [
    [a, FACE_BOTTOM, 0], [a, PLATFORM_H - 0.05, FACE_V - 0.01], [a + sg * 0.05, PLATFORM_H, FACE_V + 0.01], [a + sg * EDGE_W, PLATFORM_H, 1],
  ];
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i], ch = Math.cos(f.heading), sh = Math.sin(f.heading);
    for (const [lat, up, v] of prof) { pos.push(f.x - sh * lat - ox, f.y + up, f.z + ch * lat - oz); uv.push(ss[i], v * sizeV); }
    if (i) for (let k = 0; k < prof.length - 1; k++) {
      const p = (i - 1) * prof.length + k, q = i * prof.length + k;
      if (sg > 0) idx.push(p, p + 1, q, p + 1, q + 1, q); else idx.push(p, q, p + 1, p + 1, q, q + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

export class StationView {
  /** texture materials used only at stations: loaded as a station streams in, released after */
  static readonly MATERIALS = ['platform', 'platformEdge', 'wall', 'nameboard'];
  readonly group = new THREE.Group();
  readonly crowd: Crowd;
  /** world positions of platform lamps (Lighting moves its pooled lights here at night) */
  readonly lampSpots: THREE.Vector3[] = [];
  /** platform roofs as world-space boxes (rain stops under them) */
  readonly roofs: RoofCover[] = [];
  readonly centre = new THREE.Vector3();
  private clockCanvas: HTMLCanvasElement;
  private clockTex: THREE.CanvasTexture;
  private lastMinute = -1;

  /** `layout`: every track as surveyed (a big junction's sidings, which only one direction's view has) */
  constructor(readonly route: Route, readonly st: StationInfo, layout?: { lines: LineDef[]; switches: Switch[] }) {
    const f = newFrame();
    route.alignment.sample(st.km * 1000, f);
    const ox = f.x, oz = f.z;
    this.centre.set(f.x, f.y, f.z);
    this.group.position.set(ox, 0, oz);
    const b = new GeoBatch();
    const M = materials();
    const region = route.regions[st.regionId];
    const at = (km: number, lat: number) => { route.alignment.sampleOffset(km * 1000, lat, f); return { x: f.x - ox, y: f.y, z: f.z - oz, ry: -f.heading, h: f.heading }; };
    const r = rng(st.km * 1000);
    // freight crossing stations: the platform length is the loops' standing length; only a short
    // low service platform is built, by a small station cabin (no passenger amenities)
    const freight = !!st.servicePlatformM;
    const pfFrom = freight ? st.km - st.servicePlatformM! / 2000 : st.platformFromKm;
    const pfTo = freight ? st.km + st.servicePlatformM! / 2000 : st.platformToKm;

    // ---- platforms ----
    const strip = new Strip();
    const s0 = pfFrom * 1000, s1 = pfTo * 1000;
    const frames = [], ss = [];
    for (let s = s0; s <= s1 + 0.01; s += 5) { const fr = newFrame(); route.alignment.sample(s, fr); fr.cant = 0; frames.push(fr); ss.push(s - s0); }
    for (const p of st.platforms) {
      const a = p.from, c = p.to, sg = Math.sign(c - a);
      // A profile's direction decides which way its faces point (outward = to its left
      // when walked from the near edge to the far side for platforms right of the track).
      // Platforms left of the track (sg < 0) are mirrored, so their profiles are walked
      // the other way; otherwise their top faces point down and get culled (see-through).
      const facing = (pts: [number, number][]) => (sg < 0 ? pts.reverse() : pts);
      // platform top beyond the edge strip, far face (tiles texture, metre UVs)
      // (a profile edge walked away from the track faces down; so the top and far face are walked from the
      // far side towards the track on the right-hand platforms, and the other way on the left: the reverse
      // of the track-facing face below. The old rule had them backwards and both tops were culled from above.)
      const outward = (pts: [number, number][]) => (sg > 0 ? pts.reverse() : pts);
      strip.extrude(frames, ss, outward([[a + sg * EDGE_W, PLATFORM_H], [c, PLATFORM_H], [c, -0.2]]), ox, oz, 1, 1);
      // edge strip: top near the edge + the face toward the track (edge texture)
      const edge = new THREE.Mesh(edgeStrip(frames, ss, a, sg, ox, oz, 2), M.platformEdge);
      edge.receiveShadow = true;
      this.group.add(edge);
      // the face is hollow below FACE_BOTTOM: close it down to the formation
      strip.extrude(frames, ss, facing([[a, -0.2], [a, FACE_BOTTOM]]), ox, oz, 1, 1);
      // end ramps
      for (const km of [pfFrom, pfTo]) {
        const e = at(km, (a + c) / 2);
        b.box(0.4, PLATFORM_H + 0.2, Math.abs(c - a), mat(e.x, e.y + PLATFORM_H / 2 - 0.1, e.z, e.ry), '#9c968c', 'concrete');
      }
    }
    const pm = new THREE.Mesh(strip.geometry(), M.platform);
    pm.receiveShadow = true; pm.castShadow = true;
    this.group.add(pm);

    const top = (km: number, lat: number) => { const o = at(km, lat); o.y += PLATFORM_H; return o; };
    const big = st.type !== 'halt' && !freight;
    // a big junction: its own architecture; platform canopies only where no great roof or train shed covers them
    const jn = st.junction?.style;
    const canopies = !jn || jn === 'rajasthani';
    // Dravidian: granite slab platforms
    if (jn === 'dravidian') tint(pm.geometry, new THREE.Color(0xc4beb4));
    const shelterHalf = jn ? 0.2 : big ? 0.13 : 0.05;
    // the foot over bridge (every station with more than one platform) and its stairs: shelters, benches and
    // people keep out of the platforms' stretch under them
    const fob = fobKm(st), fobGap = fob === null ? null : fobSpan(fob);
    const underFob = (km: number) => !!fobGap && km > fobGap[0] && km < fobGap[1];
    // drinking water stalls: two on a long platform, one on a short, mid-platform along the line (between a
    // junction's column bays; clear of the tea stall, the name boards and the FOB); benches and people keep off
    const stallKms = (pfTo - pfFrom >= 0.5 ? [st.km - 0.104, st.km + 0.04] : [st.km - 0.02]).filter(k => !underFob(k));
    const nearStall = (km: number, lat: number, mid: number) => Math.abs(lat - mid) < STALL_HALF.across + 1 && stallKms.some(k => Math.abs(km - k) * 1000 < STALL_HALF.along + 1.2);
    const stalls: THREE.Matrix4[] = [];

    // ---- shelters, benches, lamps, crowd spots ----
    const spots: { x: number; y: number; z: number; heading: number }[] = [];
    const solar = big && r() < 0.5;
    for (const p of st.platforms) {
      const mid = (p.from + p.to) / 2, w = Math.abs(p.to - p.from);
      const c0 = st.km - shelterHalf - 0.003, c1 = st.km + shelterHalf + 0.003;
      if (canopies) for (const [a, z] of fobGap ? [[c0, Math.min(c1, fobGap[0])], [Math.max(c0, fobGap[1]), c1]] : [[c0, c1]]) if (z - a > 0.008) this.canopy(route, a, z, mid, w * 0.9, ox, oz, solar);
      for (const k of stallKms) { const q = top(k, mid); stalls.push(mat(q.x, q.y, q.z, q.ry)); }
      for (let km = st.km - shelterHalf; km <= st.km + shelterHalf; km += 0.006) {
        if (underFob(km) || underFob(km + 0.002)) continue;
        const o = top(km, mid);
        if (canopies) {
          // a gabled truss under each pair of posts, following the roof: tie beam at the eaves,
          // rafters under both slopes, a king post to the ridge and two struts
          const hw = w * 0.45, rise = canopyRise(w * 0.9), eave = CANOPY_EAVE - 0.1 - 0.09, ridge = eave + rise;
          const under = (l: number) => eave + rise * (1 - Math.abs(l) / hw);
          const bar = (la: number, ya: number, lb: number, yb: number, t: number) => {
            const L = Math.hypot(lb - la, yb - ya);
            b.box(t, t, L, mat(o.x, o.y + (ya + yb) / 2, o.z, o.ry).multiply(mat(0, 0, (la + lb) / 2, 0, Math.atan2(-(yb - ya), lb - la))), '#4d6b7a', 'metal');
          };
          for (const dl of [-w * 0.18, w * 0.18]) {
            const q = top(km, mid + dl), ph = under(dl);
            b.box(0.14, ph, 0.14, mat(q.x, q.y + ph / 2, q.z, q.ry), '#4d6b7a', 'metal');
          }
          bar(-hw + 0.1, eave - 0.08, hw - 0.1, eave - 0.08, 0.15);
          bar(-hw, eave, 0, ridge, 0.17);
          bar(0, ridge, hw, eave, 0.17);
          bar(0, eave - 0.08, 0, ridge, 0.1);
          for (const e of [-1, 1]) bar(e * hw * 0.55, eave - 0.08, e * hw * 0.2, under(hw * 0.2), 0.08);
          // hanging from the tie beam: a digital clock near the middle, horn speakers every 30 m
          const k = Math.round((km - st.km) / 0.006);
          if (k === 8 || k === -14) this.ledClock(top(km, mid), eave - 0.08, b);
          else if (k % 5 === 0) this.speaker(top(km, mid + (k % 10 === 0 ? 1 : -1) * w * 0.12), eave - 0.08, k % 10 === 0 ? 1 : -1, b);
        }
        if (r() < 0.5) {
          // bench: slatted seat and back on two cast-iron end frames
          const bl = mid + (r() - 0.5) * w * 0.3;
          if (nearStall(km + 0.002, bl, mid)) continue;
          const q = top(km + 0.002, bl), base = mat(q.x, q.y, q.z, q.ry);
          b.box(1.8, 0.06, 0.45, base.clone().multiply(mat(0, 0.45, 0)), '#5b4636');
          b.box(1.8, 0.4, 0.05, base.clone().multiply(mat(0, 0.75, -0.21, 0, -0.12)), '#5b4636');
          for (const e of [-0.78, 0.78]) {
            b.box(0.05, 0.45, 0.05, base.clone().multiply(mat(e, 0.225, 0.17)), '#2e2e2e', 'metal');
            b.box(0.05, 0.92, 0.05, base.clone().multiply(mat(e, 0.46, -0.2, 0, -0.12)), '#2e2e2e', 'metal');
            b.box(0.05, 0.04, 0.45, base.clone().multiply(mat(e, 0.41, 0)), '#2e2e2e', 'metal');
          }
        }
      }
      for (let km = pfFrom + 0.01; km < pfTo; km += 0.025) {
        const q = top(km, p.to - Math.sign(p.to - p.from) * 0.8);
        b.cyl(0.06, 0.08, 4.6, 6, mat(q.x, q.y + 2.3, q.z), '#56606a', 'metal');
        b.box(0.9, 0.12, 0.25, mat(q.x, q.y + 4.6, q.z, q.ry), '#fff6d8', 'lamp');
        this.lampSpots.push(new THREE.Vector3(q.x + ox, q.y + 4.4, q.z + oz));
      }
      const n = freight ? 3 : big ? 34 : 14;
      for (let i = 0; i < n; i++) {
        const km = st.km + (r() - 0.5) * (pfTo - pfFrom) * 0.75;
        const lat = p.from + (p.to - p.from) * (0.3 + r() * 0.6);
        if ((underFob(km) && Math.abs(lat - mid) < FOB.stairW / 2 + 0.6) || nearStall(km, lat, mid)) continue;
        const q = top(km, lat);
        spots.push({ x: q.x, y: q.y, z: q.z, heading: q.h });
      }
      // trilingual name boards at both ends and the middle: the board-on-posts image
      // (alpha cut-out, 4.2 m square) with the name drawn on its panel
      const t = labelTexture(st.name, { bg: '#f5d000', fg: '#111', w: 512, h: 192, lines: [st.nameHi, st.name.toUpperCase(), st.nameRegional] });
      const nameMat = new THREE.MeshStandardMaterial({ map: t, side: THREE.DoubleSide, roughness: 0.6, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.06, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
      for (const km of [pfFrom + 0.04, st.km + 0.03, pfTo - 0.04]) {
        const q = top(km, mid);
        const board = new THREE.Mesh(BOARD_GEO, M.nameboard);
        board.position.set(q.x, q.y + 2.1, q.z);
        board.rotation.y = q.ry;
        this.group.add(board);
        // name on the panel (panel = 76 % x 28 % of the image, centred 3.0 m up)
        const label = new THREE.Mesh(LABEL_GEO, nameMat);
        label.position.set(q.x, q.y + 3.0, q.z);
        label.rotation.y = q.ry;
        this.group.add(label);
      }
    }

    // ---- station building (a big junction: its architecture), clock, tea stall, water tank, FOB ----
    const side = st.buildingSide;
    const outer = st.platforms.filter(p => Math.sign(p.to) === side).reduce((m, p) => Math.max(m, Math.abs(p.to)), 0) || Math.abs(st.platforms[0].to);
    const bl = side * (outer + (big ? 6 : 3.5));
    let clockSpot: ClockSpot;
    if (jn) clockSpot = buildJunction(jn, { route, st, b, group: this.group, roofs: this.roofs, at, ox, oz, pfH: PLATFORM_H, layout,
      fit: { clock: (q, ceil) => this.ledClock(q, ceil, b), speaker: (q, ceil, dir) => this.speaker(q, ceil, dir, b), board: (m, w, h) => this.departureBoard(m, w, h, b) },
      lamps: this.lampSpots });
    else {
      const bb = at(st.km, bl);
      const stone = region.stationStyle === 'stone';
      // plains stations: rendered wall with a dado band (station-wall texture, band at the bottom); ghats: stone
      const wallKey = stone ? 'stone' : 'wall';
      const wallTint = stone ? '#c9c2b3' : '#ffffff';
      // heights in whole 3 m storeys, the height of one station-wall texture copy (dado band per floor)
      const len = big ? 38 : 10, dep = big ? 9 : 5, hgt = big ? 6 : 3;
      b.box(len, hgt, dep, mat(bb.x, bb.y + PLATFORM_H + hgt / 2 - 0.2, bb.z, bb.ry), wallTint, wallKey);
      // arched verandah facing the platform
      const vl = bl - side * (dep / 2 + 1.6);
      for (let i = -len / 2 + 1.5; i <= len / 2 - 1.5; i += 3) {
        const q = at(st.km + i / 1000, vl);
        b.box(0.5, 3.4, 0.5, mat(q.x, q.y + PLATFORM_H + 1.7, q.z, q.ry), '#f0e6d6');
      }
      const vq = at(st.km, vl);
      b.box(len, 0.35, 3.6, mat(vq.x, vq.y + PLATFORM_H + 3.55, vq.z, vq.ry), '#c94f3d');
      if (stone || !big) b.add(new THREE.CylinderGeometry(0, 1, 1, 4, 1), mat(bb.x, bb.y + PLATFORM_H + hgt + 1.0, bb.z, bb.ry + Math.PI / 4, 0, 0, (len * 0.78), 2.2, (dep * 0.85)), '#ffffff', 'roof');
      else b.box(len + 0.4, 0.8, dep + 0.4, mat(bb.x, bb.y + PLATFORM_H + hgt + 0.2, bb.z, bb.ry), '#d9c7b0', 'stone');
      for (let i = -len / 2 + 2; i < len / 2 - 1; i += 3.2) {
        const q = at(st.km + i / 1000, bl - side * (dep / 2 + 0.03));
        b.box(1.2, 1.6, 0.06, mat(q.x, q.y + PLATFORM_H + 1.6, q.z, q.ry), '#2b3640');
      }
      const cq = at(st.km, bl - side * (dep / 2 + 0.05));
      clockSpot = { x: cq.x, y: cq.y + PLATFORM_H + hgt - 1.2, z: cq.z, ry: cq.ry + (side > 0 ? Math.PI : 0), scale: 1 };
      // station name on the building
      const nameT = labelTexture(`${st.name}|bld`, { bg: '#1d3557', fg: '#fff', w: 1024, h: 128, lines: [`${st.nameHi}   ${st.name.toUpperCase()}   ${st.nameRegional}`] });
      const nb = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(len - 2, 16), 2), labelMaterial2(nameT));
      nb.position.set(cq.x, cq.y + PLATFORM_H + hgt - 2.6, cq.z);
      nb.rotation.y = clockSpot.ry;
      this.group.add(nb);
    }
    // clock (canvas redrawn each game minute)
    this.clockCanvas = document.createElement('canvas');
    this.clockCanvas.width = this.clockCanvas.height = 128;
    this.clockTex = new THREE.CanvasTexture(this.clockCanvas);
    this.clockTex.colorSpace = THREE.SRGBColorSpace;
    const clock = new THREE.Mesh(new THREE.CircleGeometry(0.75, 24), new THREE.MeshBasicMaterial({ map: this.clockTex }));
    clock.position.set(clockSpot.x, clockSpot.y, clockSpot.z);
    clock.rotation.y = clockSpot.ry;
    clock.scale.setScalar(clockSpot.scale);
    this.group.add(clock);
    this.drawClock(0);

    if (big) {
      // tea stall on the main platform
      const mp = st.platforms.find(p => p.lines.some(l => route.runningLines.some(r => r.id === l))) ?? st.platforms[0];
      const ts = top(st.km - 0.06, (mp.from + mp.to) / 2);
      b.box(2.6, 2.2, 1.8, mat(ts.x, ts.y + 1.1, ts.z, ts.ry), '#e67e22');
      b.box(3.2, 0.1, 2.4, mat(ts.x, ts.y + 2.35, ts.z, ts.ry, 0, 0.1), '#c0392b');
      b.box(2.6, 0.1, 0.5, mat(ts.x, ts.y + 1.0, ts.z, ts.ry).multiply(mat(0, 0, 1.1)), '#8e5b33');
      // water tank behind the building
      if (!jn) {
        const wt = at(st.km - 0.09, bl + side * 20);
        const gy = wt.y;
        for (const [dx, dz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) b.box(0.4, 10, 0.4, mat(wt.x + dx, gy + 5, wt.z + dz), '#bfb8aa', 'concrete');
        b.cyl(3.2, 3.2, 3.5, 16, mat(wt.x, gy + 11.7, wt.z), '#d8d2c4', 'concrete');
        b.add(new THREE.ConeGeometry(3.4, 1.2, 16), mat(wt.x, gy + 14.05, wt.z), '#bdb5a6', 'concrete');
      }
    }
    // foot over bridge across all tracks (Navyug has its air concourse; Sagarpur's is beyond the train shed)
    if (fob !== null) this.footbridge(fob, at, b);

    this.group.add(b.build(M as unknown as Record<string, THREE.Material>));
    addWaterStalls(this.group, stalls, () => this.disposed);
    this.crowd = new Crowd(spots, Math.floor(st.km * 100));
    this.group.add(this.crowd.mesh);
  }

  /**
   * Foot over bridge (layout: fobLayout): a steel bridge across all the tracks on braced trestles standing on
   * the platforms; a concrete deck between plate girders, railings both sides and a gabled roof of blue and
   * white striped sheet. From the deck's edge a covered flight of stairs comes down to the middle of every
   * platform, along it: two flights with a landing between, steel stringers, handrails, concrete treads.
   */
  private footbridge(km: number, at: (km: number, lat: number) => { x: number; y: number; z: number; ry: number }, b: GeoBatch) {
    const st = this.st;
    const lats = st.platforms.flatMap(p => [p.from, p.to]);
    const lo = Math.min(...lats) + 1.6, hi = Math.max(...lats) - 1.6, span = hi - lo + 3, cl = (lo + hi) / 2;
    const z0 = cl - span / 2, z1 = cl + span / 2;
    const deckY = RAIL_TOP + FOB.deck, deckTop = deckY + FOB.slab / 2, hw = FOB.half, W = FOB.stairW;
    const STEEL = '#8d969b', DARK = '#5f686d', CONC = '#bdb6aa', BLUE = '#7aa6d6', WHITE = '#e8edf0';
    /** a box in the bridge's frame: x along the line from the deck's centre, y above the rails' base level, at lateral offset lat */
    const box = (w: number, h: number, d: number, x: number, y: number, lat: number, col: string, key = 'metal', rz = 0) => {
      const q = at(km + x / 1000, lat);
      b.box(w, h, d, mat(q.x, q.y + y, q.z, q.ry, 0, rz), col, key);
    };
    const mids = st.platforms.map(p => (p.from + p.to) / 2);

    // deck and side girders
    box(2 * hw, FOB.slab, span, 0, deckY, cl, CONC, 'concrete');
    for (const e of [-1, 1]) box(0.22, 1.1, span, e * (hw - 0.11), deckY - 0.45, cl, STEEL);
    // railings and roof posts both sides; on the stairs' side, open where each flight comes up
    const openings = mids.map(m => [m - W / 2 - 0.05, m + W / 2 + 0.05]).sort((p, q) => p[0] - q[0]);
    for (const e of [-1, 1]) {
      const segs: [number, number][] = [];
      let a = z0;
      if (e > 0) for (const [o0, o1] of openings) { if (o0 > a) segs.push([a, o0]); a = Math.max(a, o1); }
      segs.push([a, z1]);
      for (const [s0, s1] of segs) {
        const len = s1 - s0;
        if (len < 0.1) continue;
        for (const y of [0.55, 1.1]) box(0.06, 0.06, len, e * (hw - 0.1), deckTop + y, (s0 + s1) / 2, DARK);
        const n = Math.max(1, Math.round(len / 1.5));
        for (let k = 0; k <= n; k++) {
          const z = s0 + (len * k) / n;
          box(0.06, 1.1, 0.06, e * (hw - 0.1), deckTop + 0.55, z, DARK);
          if (k % 2 === 0 || k === n) box(0.1, 2.6, 0.1, e * (hw - 0.1), deckTop + 1.3, z, STEEL);
        }
      }
    }
    // gabled roof: stripes of blue and white sheet across the span
    const Lh = hw + 0.4, al = 0.2, eave = deckTop + 2.6, L = Lh / Math.cos(al);
    for (let z = z0 - 0.3, i = 0; z < z1 + 0.3 - 1e-6; z += 1.2, i++) {
      const d = Math.min(1.2, z1 + 0.3 - z);
      for (const e of [-1, 1]) box(L, 0.05, d, (e * Lh) / 2, eave + (Lh / 2) * Math.tan(al), z + d / 2, i % 2 ? WHITE : BLUE, 'sheet', -e * al);
    }
    // trestles on the platforms: a pair of columns under the girders, cross-braced, on base plates
    const ch = deckY - 1 - PLATFORM_H, cx = hw - 0.25;
    for (const m of mids) {
      for (const e of [-1, 1]) {
        box(0.3, ch, 0.3, e * cx, PLATFORM_H + ch / 2, m, STEEL);
        box(0.6, 0.12, 0.6, e * cx, PLATFORM_H + 0.06, m, DARK);
      }
      for (const y of [PLATFORM_H + ch / 2, deckY - 1.05]) box(2 * cx, 0.15, 0.15, 0, y, m, STEEL);
      const bl = Math.hypot(2 * cx, ch / 2), ba = Math.atan2(ch / 2, 2 * cx);
      for (let k = 0; k < 2; k++) for (const sg of [-1, 1]) box(bl, 0.08, 0.08, 0, PLATFORM_H + ch / 4 + (k * ch) / 2, m, DARK, 'metal', sg * ba);
    }
    // the stairs: from the deck's edge down along each platform (two flights, a landing between them)
    const n = FOB.steps, g = FOB.going, H = deckTop - PLATFORM_H, rise = H / (2 * n);
    const run = (n - 1) * g, drop = (n - 1) * rise, fl = Math.hypot(run, drop), th = Math.atan2(drop, run);
    const xl = hw + run, x2 = xl + FOB.landing;
    for (const m of mids) {
      for (const [xs, ys] of [[hw, H], [x2, H / 2]]) {
        for (let i = 0; i < n - 1; i++) box(g + 0.02, 0.16, W, xs + (i + 0.5) * g, PLATFORM_H + ys - (i + 1) * rise - 0.08, m, i % 2 ? '#c9c2b5' : '#b7afa2', 'concrete');
        const xm = xs + run / 2, ym = PLATFORM_H + ys - drop / 2;
        for (const e of [-1, 1]) {
          const zl = m + e * (W / 2 + 0.06);
          box(fl, 0.4, 0.1, xm, ym - 0.3, zl, STEEL, 'metal', -th);
          for (const y of [0.5, 1]) box(fl, 0.05, 0.05, xm, ym + y, zl, DARK, 'metal', -th);
          for (let k = 0; k <= 4; k++) box(0.05, 1, 0.05, xs + (run * k) / 4, PLATFORM_H + ys - (drop * k) / 4 + 0.5, zl, DARK);
          for (const k of [0, 1]) box(0.08, 2.6, 0.08, xs + run * k, PLATFORM_H + ys - drop * k + 1.3, m + e * (W / 2 + 0.2), STEEL);
        }
        box(fl, 0.05, W + 0.9, xm, ym + 2.6, m, BLUE, 'sheet', -th);
      }
      // the landing: slab on two columns, railings, its own roof
      const xc = xl + FOB.landing / 2, yl = PLATFORM_H + H / 2;
      box(FOB.landing, 0.2, W + 0.2, xc, yl - 0.1, m, CONC, 'concrete');
      box(FOB.landing, 0.05, W + 0.9, xc, yl + 2.6, m, BLUE, 'sheet');
      for (const e of [-1, 1]) {
        box(0.2, H / 2 - 0.2, 0.2, x2 - 0.2, PLATFORM_H + (H / 2 - 0.2) / 2, m + e * (W / 2 - 0.1), STEEL);
        for (const y of [0.5, 1]) box(FOB.landing, 0.05, 0.05, xc, yl + y, m + e * (W / 2 + 0.06), DARK);
      }
    }
  }

  /**
   * Platform roof: one continuous gabled roof per platform following the line,
   * blue corrugated sheet on both slopes (ridges running down them) with a
   * ridge cap, a white fascia board hanging along each eave and a galvanised
   * underside. Some stations have rows of solar panels on one slope.
   */
  private canopy(route: Route, km0: number, km1: number, mid: number, width: number, ox: number, oz: number, solar: boolean) {
    const frames: TrackFrame[] = [], ss: number[] = [];
    const f = newFrame();
    for (let km = km0; km <= km1 + 1e-9; km += 0.002) {
      route.alignment.sampleOffset(km * 1000, mid, f);
      frames.push({ ...f, y: f.y + PLATFORM_H + CANOPY_EAVE, cant: 0 });
      ss.push(km * 1000 - km0 * 1000);
    }
    const hw = width / 2, rise = canopyRise(width), T = 0.1, F = 0.03;
    // counter-clockwise profiles (outward faces): top surface right to left; edges down, underside left to right
    const top = new Strip(), cap = new Strip(), under = new Strip();
    top.extrude(frames, ss, [[hw, 0], [0, rise], [-hw, 0]], ox, oz, 1, 1);
    cap.extrude(frames, ss, [[0.3, rise - 0.02], [0, rise + 0.09], [-0.3, rise - 0.02]], ox, oz, 1, 1);
    under.extrude(frames, ss, [[-hw, 0], [-hw, -T], [0, rise - T], [hw, -T], [hw, 0]], ox, oz, 1, 1);
    // fascia boards along both eaves
    for (const e of [-hw, hw]) under.extrude(frames, ss, [[e - F, 0.14], [e - F, -0.45], [e + F, -0.45], [e + F, 0.14]], ox, oz, 1, 1, true);
    // UVs: u along the platform, v across it, so the corrugations (vertical in the image) run down the slopes
    for (let i = 0; i < top.uv.length; i += 2) { const u = top.uv[i]; top.uv[i] = top.uv[i + 1]; top.uv[i + 1] = u; }
    const M = materials();
    route.alignment.sampleOffset((km0 + km1) * 500, mid, f);
    this.roofs.push({ x: f.x, z: f.z, cos: Math.cos(f.heading), sin: Math.sin(f.heading), halfLen: (km1 - km0) * 500, halfWid: hw, top: f.y + PLATFORM_H + CANOPY_EAVE });
    const roof = new THREE.Mesh(tint(top.geometry(), ROOF_BLUE), M.sheet);
    const ridge = new THREE.Mesh(tint(cap.geometry(), RIDGE_BLUE), M.sheet);
    const base = new THREE.Mesh(under.geometry(), CANOPY_UNDER);
    const parts = [roof, ridge, base];
    if (solar) {
      // panels 4 m long with 2 m gaps, 8 cm above the slope away from the track side
      const sg = mid < 0 ? -1 : 1, l0 = sg * hw * 0.12, l1 = sg * hw * 0.88, y = (l: number) => rise * (1 - Math.abs(l) / hw) + 0.08;
      const pv = new Strip(), prof: [number, number][] = sg > 0 ? [[l1, y(l1)], [l0, y(l0)]] : [[l0, y(l0)], [l1, y(l1)]];
      for (let i = 1; i + 2 < frames.length - 1; i += 3) pv.extrude(frames.slice(i, i + 3), ss.slice(i, i + 3), prof, ox, oz, 1, 1);
      if (pv.pos.length) parts.push(new THREE.Mesh(pv.geometry(), SOLAR));
    }
    for (const m of parts) { m.castShadow = true; m.receiveShadow = true; this.group.add(m); }
  }

  /** red seven-segment platform clocks (one texture per station, redrawn each minute) */
  private ledCanvas: HTMLCanvasElement | null = null;
  private ledTex: THREE.CanvasTexture | null = null;
  private ledMat: THREE.MeshBasicMaterial | null = null;

  /**
   * A digital clock hung on two drop rods from a roof member `ceil` m above the platform at `q`,
   * reading on both faces along the platform. Shared with the junction roofs.
   */
  ledClock(q: { x: number; y: number; z: number; ry: number }, ceil: number, b: GeoBatch) {
    if (!this.ledTex) {
      this.ledCanvas = document.createElement('canvas');
      this.ledCanvas.width = 256; this.ledCanvas.height = 96;
      this.ledTex = new THREE.CanvasTexture(this.ledCanvas);
      this.ledTex.colorSpace = THREE.SRGBColorSpace;
      this.ledMat = new THREE.MeshBasicMaterial({ map: this.ledTex, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
      this.drawLed(Math.max(0, this.lastMinute) * 60);
    }
    const y = Math.min(ceil - 0.5, 3.0), base = mat(q.x, q.y + y, q.z, q.ry);
    b.box(0.22, 0.5, 1.45, base, '#151515', 'metal');
    for (const e of [-0.5, 0.5]) b.box(0.03, ceil - y - 0.25, 0.03, base.clone().multiply(mat(0, (ceil - y) / 2 + 0.12, e)), '#2e2e2e', 'metal');
    for (const d of [-1, 1]) {
      const face = new THREE.Mesh(LED_GEO, this.ledMat!);
      face.applyMatrix4(base.clone().multiply(mat(d * 0.112, 0, 0, d * Math.PI / 2)));
      this.group.add(face);
    }
  }

  /** A horn loudspeaker on a bracket under a roof member `ceil` m up, its mouth along the platform (`dir` +-1). */
  speaker(q: { x: number; y: number; z: number; ry: number }, ceil: number, dir: number, b: GeoBatch) {
    const base = mat(q.x, q.y + ceil, q.z, q.ry), grey = '#c9ccc6';
    b.box(0.06, 0.32, 0.05, base.clone().multiply(mat(0, -0.16, 0)), '#6d6f6c', 'metal');
    b.box(0.3, 0.05, 0.08, base.clone().multiply(mat(0, -0.32, 0)), '#6d6f6c', 'metal');
    const horn = base.clone().multiply(mat(dir * 0.12, -0.45, 0, 0, 0, -0.12 * dir));
    b.cyl(0.07, 0.27, 0.42, 14, horn.clone().multiply(mat(dir * 0.16, 0, 0, 0, 0, dir * Math.PI / 2)), grey, 'metal');
    b.cyl(0.11, 0.11, 0.24, 10, horn.clone().multiply(mat(-dir * 0.15, 0, 0, 0, 0, Math.PI / 2)), grey, 'metal');
    b.cyl(0.2, 0.2, 0.02, 14, horn.clone().multiply(mat(dir * 0.375, 0, 0, 0, 0, Math.PI / 2)), '#3b3d3c', 'metal');
  }

  /** live departure boards (big junctions): one texture per station, redrawn by setDepartures */
  private boardCanvas: HTMLCanvasElement | null = null;
  private boardTex: THREE.CanvasTexture | null = null;
  private boardMat: THREE.MeshBasicMaterial | null = null;

  /** A departure board (`m`: its centre and facing, local; w x h m): a dark housing and the live face. */
  departureBoard(m: THREE.Matrix4, w: number, h: number, b: GeoBatch) {
    if (!this.boardTex) {
      this.boardCanvas = document.createElement('canvas');
      this.boardCanvas.width = 1024; this.boardCanvas.height = 400;
      this.boardTex = new THREE.CanvasTexture(this.boardCanvas);
      this.boardTex.colorSpace = THREE.SRGBColorSpace;
      this.boardTex.anisotropy = 4;
      this.boardMat = new THREE.MeshBasicMaterial({ map: this.boardTex, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
      this.setDepartures([]);
    }
    b.box(w + 0.3, h + 0.3, 0.25, m, '#1b1d1f', 'metal');
    const face = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 400 / 1024 > h ? h : w * 400 / 1024), this.boardMat!);
    face.applyMatrix4(m.clone().multiply(mat(0, 0, 0.13)));
    this.group.add(face);
  }

  /** Redraw the departure boards: the trains due, at or leaving the station (time, name, platform, status). */
  setDepartures(rows: { time: string; name: string; pf: string; status: string }[]) {
    if (!this.boardCanvas) return;
    const g = this.boardCanvas.getContext('2d')!, W = 1024, H = 400, amber = '#ffb43a';
    g.fillStyle = '#0b0c0e'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#16324f'; g.fillRect(0, 0, W, 58);
    g.fillStyle = '#ffffff'; g.font = 'bold 34px "Nirmala UI", Arial, sans-serif'; g.textBaseline = 'middle';
    g.textAlign = 'left'; g.fillText(`${this.st.nameHi}  ·  ${this.st.name.toUpperCase()}`, 18, 30);
    g.textAlign = 'right'; g.fillText('DEPARTURES / प्रस्थान', W - 18, 30);
    g.font = 'bold 24px Consolas, "Courier New", monospace'; g.fillStyle = '#7a8ea3'; g.textAlign = 'left';
    const cols = [18, 140, 700, 820];
    ['TIME', 'TRAIN', 'PF', 'STATUS'].forEach((t, i) => g.fillText(t, cols[i], 82));
    g.font = 'bold 30px Consolas, "Courier New", monospace';
    rows.slice(0, 7).forEach((r, i) => {
      const y = 124 + i * 40;
      if (i % 2) { g.fillStyle = '#121418'; g.fillRect(0, y - 20, W, 40); }
      g.fillStyle = amber;
      g.fillText(r.time, cols[0], y);
      g.fillText(r.name.toUpperCase().slice(0, 30), cols[1], y);
      g.fillText(r.pf, cols[2], y);
      g.fillStyle = r.status === 'ON TIME' || r.status === 'ON PLATFORM' ? '#5fe07a' : r.status === 'DEPARTING' ? '#ff6b4a' : amber;
      g.fillText(r.status, cols[3], y);
    });
    if (!rows.length) { g.fillStyle = '#7a8ea3'; g.fillText('PLEASE WAIT', cols[1], 124); }
    this.boardTex!.needsUpdate = true;
  }

  private drawLed(sec: number) {
    if (!this.ledCanvas) return;
    const g = this.ledCanvas.getContext('2d')!, W = 256, H = 96;
    g.fillStyle = '#120505'; g.fillRect(0, 0, W, H);
    const hh = Math.floor(sec / 3600) % 24, mm = Math.floor(sec / 60) % 60;
    const txt = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    g.font = 'bold 78px "Consolas", "Courier New", monospace';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#3a0d0b'; g.fillText('88:88', W / 2, H / 2 + 4); // the unlit segments
    g.shadowColor = '#ff3b22'; g.shadowBlur = 10;
    g.fillStyle = '#ff3b22'; g.fillText(txt, W / 2, H / 2 + 4);
    g.shadowBlur = 0;
    this.ledTex!.needsUpdate = true;
  }

  private drawClock(sec: number) {
    const g = this.clockCanvas.getContext('2d')!;
    g.fillStyle = '#fbfbf6'; g.beginPath(); g.arc(64, 64, 62, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#222'; g.lineWidth = 5; g.stroke();
    g.fillStyle = '#222';
    for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; g.fillRect(64 + Math.sin(a) * 50 - 2, 64 - Math.cos(a) * 50 - 2, 4, 4); }
    const h = (sec / 3600) % 12, m = (sec / 60) % 60;
    const hand = (a: number, l: number, w: number) => { g.lineWidth = w; g.beginPath(); g.moveTo(64, 64); g.lineTo(64 + Math.sin(a) * l, 64 - Math.cos(a) * l); g.stroke(); };
    hand((h / 12) * Math.PI * 2, 30, 6);
    hand((m / 60) * Math.PI * 2, 46, 4);
    this.clockTex.needsUpdate = true;
  }

  update(clockSec: number, t: number, near: boolean) {
    const minute = Math.floor(clockSec / 60);
    if (minute !== this.lastMinute) { this.lastMinute = minute; this.drawClock(clockSec); this.drawLed(clockSec); }
    if (near && this.crowd.mesh.visible) this.crowd.update(t); // hidden once the 3D people are in
  }

  private disposed = false;
  dispose() {
    this.disposed = true;
    this.group.removeFromParent();
    this.group.traverse(o => {
      const m = o as THREE.Mesh;
      if ((m as THREE.InstancedMesh).isInstancedMesh) (m as THREE.InstancedMesh).dispose();
      if (m.isMesh) m.geometry.dispose();
    });
    this.boardTex?.dispose(); this.boardMat?.dispose();
    this.clockTex.dispose();
    this.ledTex?.dispose(); this.ledMat?.dispose();
  }
}

/** A platform roof footprint (world metres): centre, along-track axis (cos, sin), half sizes, underside height. */
export interface RoofCover { x: number; z: number; cos: number; sin: number; halfLen: number; halfWid: number; top: number }

/** Is world point (x, y, z) under one of these roofs? */
export function underRoof(roofs: RoofCover[], x: number, y: number, z: number) {
  for (const c of roofs) {
    const dx = x - c.x, dz = z - c.z;
    if (y < c.top && Math.abs(dx * c.cos + dz * c.sin) < c.halfLen && Math.abs(-dx * c.sin + dz * c.cos) < c.halfWid) return true;
  }
  return false;
}

const BOARD_GEO = new THREE.PlaneGeometry(4.2, 4.2);
/** galvanised underside of platform roofs */
const CANOPY_UNDER = new THREE.MeshStandardMaterial({ color: 0xe2e6e9, roughness: 0.7, metalness: 0.05 });
/** platform canopy: eaves this high over the platform; the ridge rises with the width */
const CANOPY_EAVE = 3.72;
const canopyRise = (width: number) => Math.min(1.4, Math.max(0.5, width * 0.1));
/** face of a hanging digital clock */
const LED_GEO = new THREE.PlaneGeometry(1.3, 0.42);
const ROOF_BLUE = new THREE.Color(0x7aa6d6), RIDGE_BLUE = new THREE.Color(0x5b88b8);
/** photovoltaic panels on some platform roofs */
const SOLAR = new THREE.MeshStandardMaterial({ color: 0x2b3d5e, roughness: 0.3, metalness: 0.4 });
/** Every vertex of `g` coloured `c` (the vertex-coloured sheet material). */
function tint(g: THREE.BufferGeometry, c: THREE.Color) {
  const a = g.attributes.color.array as Float32Array;
  for (let i = 0; i < a.length; i += 3) c.toArray(a, i);
  return g;
}
const LABEL_GEO = new THREE.PlaneGeometry(3.15, 1.12);

function labelMaterial2(t: THREE.Texture) {
  return new THREE.MeshStandardMaterial({ map: t, roughness: 0.5, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.1 });
}

