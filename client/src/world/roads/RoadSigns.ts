import * as THREE from 'three/webgpu';
import { hash2 } from '@rail/shared/util';
import type { Route } from '@rail/shared/track/Route';
import { labelMaterial } from '../../core/Materials';
import { parallelRoads, type ParallelRoad } from './Highways';

/**
 * Every sign along a route's roads drawn into one atlas (one material, one draw a road piece): the generic ones
 * (speed limits, warning triangles, blue information signs, the toll plaza ahead, the 200 m stones' digits) and
 * the route's own - each km stone's faces (the road's number on its yellow top; the next town each way and its
 * distance) and the green direction boards at the junctions. Text in English; the places are the route's own
 * (fictional) stations and villages named here. The board material glows a little by night (labelMaterial).
 */
export interface SignCell { uv: [number, number, number, number] }
const W = 1024, H = 1024;

/** village names for the side roads (made up; never a real town's) */
const PRE = ['Kesar', 'Meghal', 'Neelam', 'Dhoop', 'Pawan', 'Sitar', 'Barkha', 'Chandan', 'Gulmohar', 'Kadamb', 'Amrai', 'Tulsi', 'Kanhar', 'Bansi', 'Mehndi', 'Kajri'];
const SUF = ['pura', 'khedi', 'wadi', 'gaon', 'tola', 'pada', 'basti', 'dih'];
export const villageName = (km: number) => PRE[Math.floor(hash2(Math.round(km * 100), 1, 8081) * PRE.length)] + SUF[Math.floor(hash2(Math.round(km * 100), 2, 8081) * SUF.length)];
/** a village road's length to its village (km) */
export const villageKm = (km: number) => 2 + Math.floor(hash2(Math.round(km * 100), 3, 8081) * 7);

type Draw = (g: CanvasRenderingContext2D, w: number, h: number) => void;

export class RouteSigns {
  readonly material: THREE.MeshStandardMaterial;
  private cells = new Map<string, SignCell>();

  constructor(route: Route) {
    const jobs: { key: string; w: number; h: number; draw: Draw }[] = [];
    const add = (key: string, w: number, h: number, draw: Draw) => jobs.push({ key, w, h, draw });
    // ---- generic
    for (const v of [100, 80, 60, 40]) add(`speed-${v}`, 64, 64, (g, w, h) => {
      circle(g, w / 2, h / 2, w / 2 - 1, '#c8102e'); circle(g, w / 2, h / 2, w / 2 - 8, '#ffffff');
      text(g, String(v), w / 2, h / 2 + 1, `bold ${v >= 100 ? 21 : 25}px Arial`, '#111');
    });
    const tri = (key: string, sym: Draw) => add(key, 64, 64, (g, w, h) => {
      g.fillStyle = '#c8102e'; poly(g, [[w / 2, 2], [w - 2, h - 6], [2, h - 6]]);
      g.fillStyle = '#ffffff'; poly(g, [[w / 2, 13], [w - 12, h - 11], [12, h - 11]]);
      g.fillStyle = '#111'; g.strokeStyle = '#111'; sym(g, w, h);
    });
    tri('warn-junction', (g, w) => { g.fillRect(w / 2 - 2.5, 24, 5, 30); g.fillRect(w / 2 - 12, 36, 24, 5); });
    tri('warn-breaker', (g, w) => { g.beginPath(); g.ellipse(w / 2, 50, 15, 7, 0, Math.PI, 0); g.fill(); g.fillRect(w / 2 - 20, 49, 40, 3); });
    tri('warn-cattle', (g, w) => { g.fillRect(w / 2 - 11, 34, 20, 9); g.fillRect(w / 2 + 7, 30, 6, 7); for (const x of [-10, -4, 3, 7]) g.fillRect(w / 2 + x, 43, 2, 8); });
    tri('warn-school', (g, w) => { for (const x of [-8, 6]) { g.beginPath(); g.arc(w / 2 + x, 29, 3.5, 0, 7); g.fill(); g.fillRect(w / 2 + x - 3, 33, 6, 11); g.fillRect(w / 2 + x - 3, 44, 2, 8); g.fillRect(w / 2 + x + 1, 44, 2, 8); } });
    for (const dir of [-1, 1]) tri(`warn-curve-${dir < 0 ? 'l' : 'r'}`, (g, w) => { g.lineWidth = 5; g.beginPath(); g.moveTo(w / 2 - dir * 4, 54); g.quadraticCurveTo(w / 2 - dir * 4, 34, w / 2 + dir * 8, 28); g.stroke(); poly(g, [[w / 2 + dir * 14, 25], [w / 2 + dir * 4, 21], [w / 2 + dir * 7, 34]]); });
    const blue = (key: string, sym: Draw) => add(key, 64, 64, (g, w, h) => { round(g, 1, 1, w - 2, h - 2, 6, '#1f4e9c'); round(g, 6, 6, w - 12, h - 12, 3, '#ffffff'); g.fillStyle = '#1f4e9c'; g.strokeStyle = '#1f4e9c'; sym(g, w, h); });
    blue('info-petrol', (g, w) => { g.fillRect(w / 2 - 10, 18, 14, 28); g.fillStyle = '#fff'; g.fillRect(w / 2 - 7, 22, 8, 7); g.fillStyle = '#1f4e9c'; g.lineWidth = 3; g.beginPath(); g.moveTo(w / 2 + 4, 26); g.lineTo(w / 2 + 11, 30); g.lineTo(w / 2 + 11, 42); g.stroke(); });
    blue('info-hospital', (g, w) => { g.fillStyle = '#c8102e'; g.fillRect(w / 2 - 4, 16, 8, 32); g.fillRect(w / 2 - 16, 28, 32, 8); });
    blue('info-food', (g, w) => { g.lineWidth = 3; for (const x of [-9, -5, -1]) { g.beginPath(); g.moveTo(w / 2 + x, 16); g.lineTo(w / 2 + x, 26); g.stroke(); } g.fillRect(w / 2 - 6.5, 25, 3, 23); g.beginPath(); g.ellipse(w / 2 + 9, 24, 4, 8, 0, 0, 7); g.fill(); g.fillRect(w / 2 + 7.5, 30, 3, 18); });
    blue('info-bus', (g, w) => { round(g, w / 2 - 15, 18, 30, 24, 4, '#1f4e9c'); g.fillStyle = '#fff'; g.fillRect(w / 2 - 11, 22, 22, 9); g.fillStyle = '#1f4e9c'; for (const x of [-9, 6]) { g.beginPath(); g.arc(w / 2 + x, 44, 3.5, 0, 7); g.fill(); } });
    blue('info-uturn', (g, w) => { g.lineWidth = 5; g.beginPath(); g.moveTo(w / 2 + 9, 48); g.lineTo(w / 2 + 9, 28); g.arc(w / 2, 28, 9, 0, Math.PI, true); g.lineTo(w / 2 - 9, 40); g.stroke(); poly(g, [[w / 2 - 16, 38], [w / 2 - 2, 38], [w / 2 - 9, 49]]); });
    add('toll-500', 192, 96, (g, w, h) => { round(g, 1, 1, w - 2, h - 2, 8, '#1f4e9c'); g.strokeStyle = '#fff'; g.lineWidth = 3; g.strokeRect(7, 7, w - 14, h - 14); text(g, 'TOLL PLAZA', w / 2, 36, 'bold 26px Arial', '#fff'); text(g, '500 m', w / 2, 68, 'bold 24px Arial', '#fff'); });
    // a fuel station's pylon panel: a made-up brand (Pathik: "traveller"), a drop, its colours
    add('brand-fuel', 96, 128, (g, w, h) => {
      round(g, 1, 1, w - 2, h - 2, 6, '#0f6b4a'); round(g, 6, 6, w - 12, 70, 4, '#f6c445');
      g.fillStyle = '#0f6b4a'; g.beginPath(); g.moveTo(w / 2, 14); g.quadraticCurveTo(w / 2 + 16, 40, w / 2, 58); g.quadraticCurveTo(w / 2 - 16, 40, w / 2, 14); g.fill();
      text(g, 'PATHIK', w / 2, 92, 'bold 20px Arial', '#ffffff'); text(g, 'FUELS', w / 2, 112, 'bold 15px Arial', '#f6c445');
    });
    for (const d of [2, 4, 6, 8]) add(`hm-${d}`, 32, 32, (g, w, h) => { g.fillStyle = '#f4f2ec'; g.fillRect(0, 0, w, h); text(g, String(d), w / 2, h / 2 + 1, 'bold 22px Arial', '#111'); });
    // ---- the route's own: km stones and junction boards
    const stations = route.stations;
    const towns = (km: number, dir: 1 | -1) => {
      const ahead = stations.filter(s => (s.km - km) * dir > 0.3).sort((a, b) => (a.km - b.km) * dir)[0] ?? stations[dir > 0 ? stations.length - 1 : 0];
      return { name: ahead.name, km: Math.max(1, Math.round(Math.abs(ahead.km - km))) };
    };
    for (const r of parallelRoads(route)) {
      if (r.kind === 'street') continue;
      const yellow = r.kind === 'nh' ? '#f1c40f' : '#2e8b57';
      for (let km = Math.ceil(r.fromKm); km <= r.toKm; km++) for (const dir of [1, -1] as const) {
        const t = towns(km, dir);
        add(stoneKey(r, km, dir), 64, 80, (g, w, h) => {
          g.fillStyle = '#f6f4ee'; g.fillRect(0, 0, w, h);
          g.fillStyle = yellow; g.beginPath(); g.moveTo(0, 30); g.lineTo(0, 16); g.arc(w / 2, 16, w / 2, Math.PI, 0); g.lineTo(w, 30); g.fill();
          text(g, r.number, w / 2, 20, 'bold 13px Arial', r.kind === 'nh' ? '#111' : '#fff');
          text(g, short(t.name), w / 2, 46, 'bold 12px Arial', '#111');
          text(g, String(t.km), w / 2, 64, 'bold 17px Arial', '#111');
        });
      }
      for (const j of r.junctions) for (const dir of [1, -1] as const) {
        const t = towns(j, dir), v = villageName(j), vk = villageKm(j);
        // the village road goes off to the left of traffic going up the km (away from the line) or to the right
        add(boardKey(r, j, dir), 256, 128, (g, w, h) => {
          round(g, 1, 1, w - 2, h - 2, 10, '#0f6b3a');
          g.strokeStyle = '#ffffff'; g.lineWidth = 3; g.strokeRect(6, 6, w - 12, h - 12);
          round(g, w - 74, 12, 62, 24, 4, r.kind === 'nh' ? '#f1c40f' : '#ffffff');
          text(g, r.number, w - 43, 25, 'bold 15px Arial', '#111');
          const away = dir === -r.side ? 'left' : 'right';
          g.textAlign = 'left'; g.fillStyle = '#fff'; g.font = 'bold 22px Arial';
          g.fillText(`${t.name}  ${t.km}`, 40, 58);
          g.fillText(`${v}  ${vk}`, 40, 98);
          g.textAlign = 'center';
          arrow(g, 22, 52, 'up'); arrow(g, 22, 92, away);
        });
      }
    }
    // ---- pack (shelves, tallest first) and draw
    jobs.sort((a, b) => b.h - a.h);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d')!;
    g.fillStyle = '#808080'; g.fillRect(0, 0, W, H);
    let x = 0, y = 0, rowH = 0;
    for (const j of jobs) {
      if (x + j.w > W) { x = 0; y += rowH + 2; rowH = 0; }
      if (y + j.h > H) { console.warn(`[signs] atlas full: ${j.key} left out`); continue; }
      g.save(); g.translate(x, y); g.beginPath(); g.rect(0, 0, j.w, j.h); g.clip();
      g.textAlign = 'center'; g.textBaseline = 'middle';
      j.draw(g, j.w, j.h);
      g.restore();
      this.cells.set(j.key, { uv: [(x + 0.5) / W, 1 - (y + j.h - 0.5) / H, (x + j.w - 0.5) / W, 1 - (y + 0.5) / H] });
      x += j.w + 2; rowH = Math.max(rowH, j.h);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    this.material = labelMaterial(t);
  }

  cell(key: string) { return this.cells.get(key); }
}

export const stoneKey = (r: ParallelRoad, km: number, dir: 1 | -1) => `km:${r.id}:${km}:${dir}`;
export const boardKey = (r: ParallelRoad, km: number, dir: 1 | -1) => `board:${r.id}:${km}:${dir}`;

const cache = new WeakMap<Route, RouteSigns>();
export function routeSigns(route: Route) {
  let s = cache.get(route);
  if (!s) cache.set(route, (s = new RouteSigns(route)));
  return s;
}

const short = (s: string) => (s.length > 9 ? s.slice(0, 8) + '.' : s);
function text(g: CanvasRenderingContext2D, s: string, x: number, y: number, font: string, col: string) { g.font = font; g.fillStyle = col; g.fillText(s, x, y); }
function circle(g: CanvasRenderingContext2D, x: number, y: number, r: number, col: string) { g.fillStyle = col; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); }
function poly(g: CanvasRenderingContext2D, p: number[][]) { g.beginPath(); g.moveTo(p[0][0], p[0][1]); for (const q of p.slice(1)) g.lineTo(q[0], q[1]); g.closePath(); g.fill(); }
function round(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, col: string) { g.fillStyle = col; g.beginPath(); g.roundRect(x, y, w, h, r); g.fill(); }
function arrow(g: CanvasRenderingContext2D, x: number, y: number, dir: 'up' | 'left' | 'right') {
  g.save(); g.translate(x, y); g.rotate(dir === 'up' ? 0 : dir === 'left' ? -Math.PI / 2 : Math.PI / 2);
  g.fillStyle = '#fff'; g.fillRect(-2.5, -4, 5, 14); poly(g, [[-9, -3], [9, -3], [0, -13]]);
  g.restore();
}
