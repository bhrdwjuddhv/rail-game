import { newFrame } from '@rail/shared/track/Chainage';
import type { Route } from '@rail/shared/track/Route';

export interface MapTrain {
  /** surveyed km */
  km: number;
  player: boolean;
  /** running line the train is on (double line: UP / DOWN) */
  line: string;
}

/**
 * Route map with stations, structures and train positions. M toggles a large
 * view. A double line is drawn as two strokes (Down on the left of +km, Up on
 * the right) with the player's line highlighted; trains sit on their line.
 * A long route (a Route Mode journey) shows only the stretch around the
 * player's train, moving along with it; station names never overlap.
 */
/** routes longer than this (km) show a window round the train: half its length, small and large map */
const LONG_KM = 30, WINDOW_KM = { small: 5, large: 12 };
export class Minimap {
  readonly canvas = document.createElement('canvas');
  private g: CanvasRenderingContext2D;
  private pts: { x: number; z: number }[] = [];
  private bounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  large = false;
  /** extra dots (God Mode billboard slots), world x / z */
  markers: { x: number; z: number; color: string }[] | null = null;

  constructor(parent: HTMLElement, private route: Route, private playerLine = () => route.running.id) {
    this.canvas.className = 'minimap';
    this.g = this.canvas.getContext('2d')!;
    parent.appendChild(this.canvas);
    const f = newFrame();
    for (let s = 0; s <= route.alignment.length; s += 100) {
      route.alignment.sample(s, f);
      this.pts.push({ x: f.x, z: f.z });
    }
    const b = this.bounds;
    b.minX = Math.min(...this.pts.map(p => p.x)); b.maxX = Math.max(...this.pts.map(p => p.x));
    b.minZ = Math.min(...this.pts.map(p => p.z)); b.maxZ = Math.max(...this.pts.map(p => p.z));
    this.resize();
  }

  toggle() { this.large = !this.large; this.resize(); }
  private resize() {
    const s = this.large ? 560 : 210;
    this.canvas.width = s; this.canvas.height = s;
    this.canvas.classList.toggle('large', this.large);
  }

  /** the stretch drawn: the whole route, or a window round the player's train on a long one */
  private view(trains: MapTrain[]) {
    const p = trains.find(t => t.player);
    if (this.route.lengthKm <= LONG_KM || !p) return this.bounds;
    const half = this.large ? WINDOW_KM.large : WINDOW_KM.small;
    const i0 = Math.max(0, Math.floor((p.km - half) * 10)), i1 = Math.min(this.pts.length - 1, Math.ceil((p.km + half) * 10));
    const w = this.pts.slice(i0, i1 + 1);
    return { minX: Math.min(...w.map(q => q.x)), maxX: Math.max(...w.map(q => q.x)), minZ: Math.min(...w.map(q => q.z)), maxZ: Math.max(...w.map(q => q.z)) };
  }

  draw(trains: MapTrain[], camera: { x: number; z: number }) {
    const g = this.g, S = this.canvas.width;
    const b = this.view(trains), pad = 14;
    const sc = Math.min((S - pad * 2) / (b.maxX - b.minX || 1), (S - pad * 2) / (b.maxZ - b.minZ || 1));
    const X = (x: number) => pad + (x - b.minX) * sc + ((S - pad * 2) - (b.maxX - b.minX) * sc) / 2;
    const Z = (z: number) => pad + (z - b.minZ) * sc + ((S - pad * 2) - (b.maxZ - b.minZ) * sc) / 2;
    g.clearRect(0, 0, S, S);
    g.fillStyle = 'rgba(10,14,18,0.75)'; g.fillRect(0, 0, S, S);
    // region colouring along the line
    const f = newFrame();
    const lines = this.route.runningLines;
    const sep = lines.length > 1 ? (this.large ? 3 : 2) : 0; // screen px between the two strokes
    // screen-space normal at point i (right of +km)
    const nrm = (i: number) => {
      const a = this.pts[Math.max(0, i - 1)], b = this.pts[Math.min(this.pts.length - 1, i + 1)];
      const dx = X(b.x) - X(a.x), dz = Z(b.z) - Z(a.z), l = Math.hypot(dx, dz) || 1;
      return { x: -dz / l, z: dx / l };
    };
    const side = (id: string) => Math.sign(lines.find(l => l.id === id)?.offset ?? 0);
    for (const l of lines) {
      const mine = l.id === this.playerLine();
      g.lineWidth = lines.length > 1 ? (mine ? 2.5 : 1.5) : 3;
      g.globalAlpha = mine || lines.length === 1 ? 1 : 0.55;
      const o = Math.sign(l.offset) * sep;
      for (let i = 1; i < this.pts.length; i++) {
        const km = (i * 100) / 1000;
        const st = this.route.structureAt(km);
        g.strokeStyle = st?.type === 'tunnel' ? '#6b5a44' : st ? '#9ad' : this.route.ghatFactor(km) > 0.5 ? '#5f9a52' : '#c9b26a';
        const n0 = nrm(i - 1), n1 = nrm(i);
        g.beginPath();
        g.moveTo(X(this.pts[i - 1].x) + n0.x * o, Z(this.pts[i - 1].z) + n0.z * o);
        g.lineTo(X(this.pts[i].x) + n1.x * o, Z(this.pts[i].z) + n1.z * o);
        g.stroke();
      }
    }
    g.globalAlpha = 1;
    g.font = `${this.large ? 13 : 10}px sans-serif`;
    // stations on the map; a name is left out where it would overlap one already written (junctions first)
    const taken: [number, number, number, number][] = [];
    const order = [...this.route.stations].sort((a, c) => Number(!!c.junction) - Number(!!a.junction));
    for (const st of order) {
      this.route.alignment.sample(st.km * 1000, f);
      const x = X(f.x), z = Z(f.z);
      if (x < -10 || x > S + 10 || z < -10 || z > S + 10) continue;
      g.fillStyle = st.junction ? '#ff9933' : '#fff';
      const r = st.junction ? 4.5 : 3;
      g.fillRect(x - r, z - r, r * 2, r * 2);
      const text = this.large || st.junction ? st.name : st.code, w = g.measureText(text).width, h = this.large ? 13 : 10;
      const box: [number, number, number, number] = [x + 6, z + 4 - h, x + 6 + w, z + 4];
      if (box[2] > S - 2 || taken.some(t => box[0] < t[2] && box[2] > t[0] && box[1] < t[3] && box[3] > t[1])) continue;
      taken.push(box);
      g.fillStyle = '#fff';
      g.fillText(text, box[0], z + 4);
    }
    for (const t of trains) {
      this.route.alignment.sample(t.km * 1000, f);
      const n = nrm(Math.round(Math.max(0, Math.min(this.route.lengthKm, t.km)) * 10));
      const o = side(t.line) * sep * 1.5;
      g.fillStyle = t.player ? '#ff4d3a' : '#4da3ff';
      g.beginPath(); g.arc(X(f.x) + n.x * o, Z(f.z) + n.z * o, t.player ? 5 : 4, 0, Math.PI * 2); g.fill();
    }
    if (lines.length > 1) {
      g.fillStyle = '#ddd'; g.font = `${this.large ? 12 : 10}px sans-serif`;
      g.fillText(`On ${this.playerLine()} line`, 6, S - 6);
    }
    if (this.markers) for (const m of this.markers) { g.fillStyle = m.color; g.fillRect(X(m.x) - 1.5, Z(m.z) - 1.5, 3, 3); }
    g.strokeStyle = 'rgba(255,255,255,0.6)'; g.lineWidth = 1;
    g.beginPath(); g.arc(X(camera.x), Z(camera.z), 6, 0, Math.PI * 2); g.stroke();
  }
}
