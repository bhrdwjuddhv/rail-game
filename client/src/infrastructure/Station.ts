import * as THREE from 'three/webgpu';
import { GeoBatch, mat } from '../core/GeoBatch';
import { labelTexture } from '../core/Textures';
import { materials } from '../core/Materials';
import { rng } from '@rail/shared/util';
import { newFrame, RAIL_TOP } from '@rail/shared/track/Chainage';
import { Strip } from '../track/TrackMeshBuilder';
import type { Route, StationInfo } from '@rail/shared/track/Route';
import { Crowd } from '../world/people/Crowd';

/** Platform surface above formation level (high-level platform, 760 mm above rail). */
export const PLATFORM_H = RAIL_TOP + 0.76;

export class StationView {
  readonly group = new THREE.Group();
  readonly crowd: Crowd;
  /** world positions of platform lamps (Lighting moves its pooled lights here at night) */
  readonly lampSpots: THREE.Vector3[] = [];
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

    // ---- platforms ----
    const strip = new Strip(), coping = new Strip();
    const s0 = st.platformFromKm * 1000, s1 = st.platformToKm * 1000;
    const frames = [], ss = [];
    for (let s = s0; s <= s1 + 0.01; s += 5) { const fr = newFrame(); route.alignment.sample(s, fr); fr.cant = 0; frames.push(fr); ss.push(s - s0); }
    for (const p of st.platforms) {
      const a = p.from, c = p.to, sg = Math.sign(c - a);
      strip.extrude(frames, ss, [[a, -0.2], [a, PLATFORM_H - 0.05], [a + sg * 0.05, PLATFORM_H], [c, PLATFORM_H], [c, -0.2]], ox, oz, 1, 1);
      coping.extrude(frames, ss, [[a + sg * 0.02, PLATFORM_H + 0.006], [a + sg * 0.5, PLATFORM_H + 0.006]], ox, oz, 1, 1);
      // end ramps
      for (const km of [st.platformFromKm, st.platformToKm]) {
        const e = at(km, (a + c) / 2);
        b.box(0.4, PLATFORM_H + 0.2, Math.abs(c - a), mat(e.x, e.y + PLATFORM_H / 2 - 0.1, e.z, e.ry), '#9c968c', 'concrete');
      }
    }
    const pm = new THREE.Mesh(strip.geometry(), M.concrete);
    pm.receiveShadow = true; pm.castShadow = true;
    this.group.add(pm);
    const cm = new THREE.Mesh(coping.geometry(), new THREE.MeshStandardMaterial({ color: 0xe8c22a, roughness: 0.7 }));
    cm.receiveShadow = true;
    this.group.add(cm);

    const top = (km: number, lat: number) => { const o = at(km, lat); o.y += PLATFORM_H; return o; };
    const big = st.type !== 'halt';
    const shelterHalf = big ? 0.13 : 0.05;

    // ---- shelters, benches, lamps, crowd spots ----
    const spots: { x: number; y: number; z: number; heading: number }[] = [];
    for (const p of st.platforms) {
      const mid = (p.from + p.to) / 2, w = Math.abs(p.to - p.from);
      for (let km = st.km - shelterHalf; km <= st.km + shelterHalf; km += 0.006) {
        const o = top(km, mid);
        for (const dl of [-w * 0.18, w * 0.18]) {
          const q = top(km, mid + dl);
          b.box(0.12, 3.6, 0.12, mat(q.x, q.y + 1.8, q.z, q.ry), '#4d6b7a', 'metal');
        }
        b.box(6.1, 0.08, w * 0.85, mat(o.x, o.y + 3.75, o.z, o.ry, 0, 0.05), '#a8b0b4', 'sheet');
        if (r() < 0.5) {
          const q = top(km + 0.002, mid + (r() - 0.5) * w * 0.3);
          b.box(1.8, 0.08, 0.45, mat(q.x, q.y + 0.45, q.z, q.ry), '#5b4636');
          b.box(1.8, 0.4, 0.06, mat(q.x, q.y + 0.75, q.z, q.ry).multiply(mat(0, 0, -0.2)), '#5b4636');
        }
      }
      for (let km = st.platformFromKm + 0.01; km < st.platformToKm; km += 0.025) {
        const q = top(km, p.to - Math.sign(p.to - p.from) * 0.8);
        b.cyl(0.06, 0.08, 4.6, 6, mat(q.x, q.y + 2.3, q.z), '#56606a', 'metal');
        b.box(0.9, 0.12, 0.25, mat(q.x, q.y + 4.6, q.z, q.ry), '#fff6d8', 'lamp');
        this.lampSpots.push(new THREE.Vector3(q.x + ox, q.y + 4.4, q.z + oz));
      }
      const n = big ? 34 : 14;
      for (let i = 0; i < n; i++) {
        const km = st.km + (r() - 0.5) * (st.platformToKm - st.platformFromKm) * 0.75;
        const lat = p.from + (p.to - p.from) * (0.3 + r() * 0.6);
        const q = top(km, lat);
        spots.push({ x: q.x, y: q.y, z: q.z, heading: q.h });
      }
      // trilingual name boards at both ends and the middle
      for (const km of [st.platformFromKm + 0.04, st.km + 0.03, st.platformToKm - 0.04]) {
        const q = top(km, mid);
        for (const dl of [-1.7, 1.7]) b.box(0.1, 3, 0.1, mat(q.x + Math.cos(q.h) * dl, q.y + 1.5, q.z + Math.sin(q.h) * dl), '#333');
        const t = labelTexture(st.name, { bg: '#f5d000', fg: '#111', w: 512, h: 256, border: '#111', lines: [st.nameHi, st.name.toUpperCase(), st.nameRegional] });
        const board = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 2.1), new THREE.MeshStandardMaterial({ map: t, side: THREE.DoubleSide, roughness: 0.6, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.06 }));
        board.position.set(q.x, q.y + 3.5, q.z);
        board.rotation.y = q.ry;
        this.group.add(board);
      }
    }

    // ---- station building, clock, tea stall, water tank, FOB ----
    const side = st.buildingSide;
    const outer = st.platforms.filter(p => Math.sign(p.to) === side).reduce((m, p) => Math.max(m, Math.abs(p.to)), 0) || Math.abs(st.platforms[0].to);
    const bl = side * (outer + (big ? 6 : 3.5));
    const bb = at(st.km, bl);
    const stone = region.stationStyle === 'stone';
    const wallKey = stone ? 'stone' : 'brick';
    const len = big ? 38 : 10, dep = big ? 9 : 5, hgt = big ? 6.5 : 3.6;
    b.box(len, hgt, dep, mat(bb.x, bb.y + PLATFORM_H + hgt / 2 - 0.2, bb.z, bb.ry), stone ? '#c9c2b3' : '#e8d8c4', wallKey);
    // arched verandah facing the platform
    const vl = bl - side * (dep / 2 + 1.6);
    for (let i = -len / 2 + 1.5; i <= len / 2 - 1.5; i += 3) {
      const q = at(st.km + i / 1000, vl);
      b.box(0.5, 3.4, 0.5, mat(q.x, q.y + PLATFORM_H + 1.7, q.z, q.ry), '#f0e6d6');
    }
    const vq = at(st.km, vl);
    b.box(len, 0.35, 3.6, mat(vq.x, vq.y + PLATFORM_H + 3.55, vq.z, vq.ry), '#c94f3d');
    if (stone || !big) b.add(new THREE.CylinderGeometry(0, 1, 1, 4, 1), mat(bb.x, bb.y + PLATFORM_H + hgt + 1.0, bb.z, bb.ry + Math.PI / 4, 0, 0, (len * 0.78), 2.2, (dep * 0.85)), '#ffffff', 'roof');
    else b.box(len + 0.4, 0.8, dep + 0.4, mat(bb.x, bb.y + PLATFORM_H + hgt + 0.2, bb.z, bb.ry), '#d9c7b0', wallKey);
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
      const mp = st.platforms.find(p => p.lines.includes('main')) ?? st.platforms[0];
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

function labelMaterial2(t: THREE.Texture) {
  return new THREE.MeshStandardMaterial({ map: t, roughness: 0.5, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.1 });
}

