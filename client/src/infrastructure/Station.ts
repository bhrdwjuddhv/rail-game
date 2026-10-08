import * as THREE from 'three/webgpu';
import { GeoBatch, mat } from '../core/GeoBatch';
import { labelTexture } from '../core/Textures';
import { materials } from '../core/Materials';
import { rng } from '@rail/shared/util';
import { newFrame, RAIL_TOP, TrackFrame } from '@rail/shared/track/Chainage';
import { Strip } from '../track/TrackMeshBuilder';
import type { Route, StationInfo } from '@rail/shared/track/Route';
import { Crowd } from '../world/people/Crowd';

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

  constructor(readonly route: Route, readonly st: StationInfo) {
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
      strip.extrude(frames, ss, facing([[a + sg * EDGE_W, PLATFORM_H], [c, PLATFORM_H], [c, -0.2]]), ox, oz, 1, 1);
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
    const shelterHalf = big ? 0.13 : 0.05;

    // ---- shelters, benches, lamps, crowd spots ----
    const spots: { x: number; y: number; z: number; heading: number }[] = [];
    for (const p of st.platforms) {
      const mid = (p.from + p.to) / 2, w = Math.abs(p.to - p.from);
      this.canopy(route, st.km - shelterHalf - 0.003, st.km + shelterHalf + 0.003, mid, w * 0.9, ox, oz);
      for (let km = st.km - shelterHalf; km <= st.km + shelterHalf; km += 0.006) {
        const o = top(km, mid);
        for (const dl of [-w * 0.18, w * 0.18]) {
          const q = top(km, mid + dl);
          b.box(0.12, 3.6, 0.12, mat(q.x, q.y + 1.8, q.z, q.ry), '#4d6b7a', 'metal');
        }
        // cross beam under the roof on each pair of posts
        b.box(0.14, 0.18, w * 0.5, mat(o.x, o.y + 3.62, o.z, o.ry), '#4d6b7a', 'metal');
        if (r() < 0.5) {
          const q = top(km + 0.002, mid + (r() - 0.5) * w * 0.3);
          b.box(1.8, 0.08, 0.45, mat(q.x, q.y + 0.45, q.z, q.ry), '#5b4636');
          b.box(1.8, 0.4, 0.06, mat(q.x, q.y + 0.75, q.z, q.ry).multiply(mat(0, 0, -0.2)), '#5b4636');
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

    // ---- station building, clock, tea stall, water tank, FOB ----
    const side = st.buildingSide;
    const outer = st.platforms.filter(p => Math.sign(p.to) === side).reduce((m, p) => Math.max(m, Math.abs(p.to)), 0) || Math.abs(st.platforms[0].to);
    const bl = side * (outer + (big ? 6 : 3.5));
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
    // clock (canvas redrawn each game minute)
    this.clockCanvas = document.createElement('canvas');
    this.clockCanvas.width = this.clockCanvas.height = 128;
    this.clockTex = new THREE.CanvasTexture(this.clockCanvas);
    this.clockTex.colorSpace = THREE.SRGBColorSpace;
    const clock = new THREE.Mesh(new THREE.CircleGeometry(0.75, 24), new THREE.MeshBasicMaterial({ map: this.clockTex }));
    const cq = at(st.km, bl - side * (dep / 2 + 0.05));
    clock.position.set(cq.x, cq.y + PLATFORM_H + hgt - 1.2, cq.z);
    clock.rotation.y = cq.ry + (side > 0 ? Math.PI : 0);
    this.group.add(clock);
    this.drawClock(0);
    // station name on the building
    const nameT = labelTexture(`${st.name}|bld`, { bg: '#1d3557', fg: '#fff', w: 1024, h: 128, lines: [`${st.nameHi}   ${st.name.toUpperCase()}   ${st.nameRegional}`] });
    const nb = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(len - 2, 16), 2), labelMaterial2(nameT));
    nb.position.set(cq.x, cq.y + PLATFORM_H + hgt - 2.6, cq.z);
    nb.rotation.y = clock.rotation.y;
    this.group.add(nb);

    if (big) {
      // tea stall on the main platform
      const mp = st.platforms.find(p => p.lines.some(l => route.runningLines.some(r => r.id === l))) ?? st.platforms[0];
      const ts = top(st.km - 0.06, (mp.from + mp.to) / 2);
      b.box(2.6, 2.2, 1.8, mat(ts.x, ts.y + 1.1, ts.z, ts.ry), '#e67e22');
      b.box(3.2, 0.1, 2.4, mat(ts.x, ts.y + 2.35, ts.z, ts.ry, 0, 0.1), '#c0392b');
      b.box(2.6, 0.1, 0.5, mat(ts.x, ts.y + 1.0, ts.z, ts.ry).multiply(mat(0, 0, 1.1)), '#8e5b33');
      // water tank behind the building
      const wt = at(st.km - 0.09, bl + side * 20);
      const gy = wt.y;
      for (const [dx, dz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) b.box(0.4, 10, 0.4, mat(wt.x + dx, gy + 5, wt.z + dz), '#bfb8aa', 'concrete');
      b.cyl(3.2, 3.2, 3.5, 16, mat(wt.x, gy + 11.7, wt.z), '#d8d2c4', 'concrete');
      b.add(new THREE.ConeGeometry(3.4, 1.2, 16), mat(wt.x, gy + 14.05, wt.z), '#bdb5a6', 'concrete');
      // foot over bridge across all tracks
      if (st.platforms.length > 1) {
        const lats = st.platforms.flatMap(p => [p.from, p.to]);
        const lo = Math.min(...lats) + 1.6, hi = Math.max(...lats) - 1.6;
        const km = st.km + 0.09;
        const deckY = RAIL_TOP + 8.4;
        const c = at(km, (lo + hi) / 2);
        b.box(3, 0.4, hi - lo + 3, mat(c.x, c.y + deckY, c.z, c.ry), '#b3aca0', 'concrete');
        b.box(3.2, 0.12, hi - lo + 3.4, mat(c.x, c.y + deckY + 2.5, c.z, c.ry), '#8f989c', 'sheet');
        for (const l of [lo, hi]) {
          const q = at(km, l);
          b.box(3, deckY - PLATFORM_H + 2.4, 3, mat(q.x, q.y + PLATFORM_H + (deckY - PLATFORM_H + 2.4) / 2, q.z, q.ry), '#cfc6b6', 'concrete');
        }
        for (const s of [-1, 1]) {
          const q = at(km + s * 0.0015, (lo + hi) / 2);
          b.box(0.08, 1.1, hi - lo, mat(q.x, q.y + deckY + 0.75, q.z, q.ry), '#59636b', 'metal');
        }
      }
    }

    this.group.add(b.build(M as unknown as Record<string, THREE.Material>));
    this.crowd = new Crowd(spots, Math.floor(st.km * 100));
    this.group.add(this.crowd.mesh);
  }

  /**
   * Platform roof: one continuous slab per platform following the line (no
   * gaps between panels), 10 cm thick, falling 5 % away from the track side.
   * Tin roof on top with its ridges running down the slope; the underside and
   * edges are plain galvanised sheet so the roof reads as solid from below.
   */
  private canopy(route: Route, km0: number, km1: number, mid: number, width: number, ox: number, oz: number) {
    const frames: TrackFrame[] = [], ss: number[] = [];
    const f = newFrame();
    for (let km = km0; km <= km1 + 1e-9; km += 0.002) {
      route.alignment.sampleOffset(km * 1000, mid, f);
      frames.push({ ...f, y: f.y + PLATFORM_H + 3.72, cant: 0 });
      ss.push(km * 1000 - km0 * 1000);
    }
    const hw = width / 2, fall = width * 0.05 * (mid < 0 ? 1 : -1); // lower edge away from the tracks
    const yR = fall / 2, yL = -fall / 2, T = 0.1;
    // counter-clockwise profiles (outward faces): top surface right to left; then left edge, underside, right edge
    const top = new Strip(), under = new Strip();
    top.extrude(frames, ss, [[hw, yR], [-hw, yL]], ox, oz, 1, 1);
    under.extrude(frames, ss, [[-hw, yL], [-hw, yL - T], [hw, yR - T], [hw, yR]], ox, oz, 1, 1);
    // UVs: u along the platform, v across it, so the corrugations (vertical in the image) run down the slope
    for (let i = 0; i < top.uv.length; i += 2) { const u = top.uv[i]; top.uv[i] = top.uv[i + 1]; top.uv[i + 1] = u; }
    const M = materials();
    route.alignment.sampleOffset((km0 + km1) * 500, mid, f);
    this.roofs.push({ x: f.x, z: f.z, cos: Math.cos(f.heading), sin: Math.sin(f.heading), halfLen: (km1 - km0) * 500, halfWid: hw, top: f.y + PLATFORM_H + 3.72 });
    const roof = new THREE.Mesh(top.geometry(), M.sheet);
    const base = new THREE.Mesh(under.geometry(), CANOPY_UNDER);
    for (const m of [roof, base]) { m.castShadow = true; m.receiveShadow = true; this.group.add(m); }
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
    if (minute !== this.lastMinute) { this.lastMinute = minute; this.drawClock(clockSec); }
    if (near) this.crowd.update(t);
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
    this.clockTex.dispose();
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
const LABEL_GEO = new THREE.PlaneGeometry(3.15, 1.12);

function labelMaterial2(t: THREE.Texture) {
  return new THREE.MeshStandardMaterial({ map: t, roughness: 0.5, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.1 });
}

