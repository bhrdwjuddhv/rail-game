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
 */
export class Minimap {
  readonly canvas = document.createElement('canvas');
  private g: CanvasRenderingContext2D;
  private pts: { x: number; z: number }[] = [];
  private bounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  large = false;

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

  draw(trains: MapTrain[], camera: { x: number; z: number }) {
    const g = this.g, S = this.canvas.width;
    const b = this.bounds, pad = 14;
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
    for (const st of this.route.stations) {
      this.route.alignment.sample(st.km * 1000, f);
      g.fillStyle = '#fff'; g.fillRect(X(f.x) - 3, Z(f.z) - 3, 6, 6);
      g.fillText(this.large ? st.name : st.code, X(f.x) + 6, Z(f.z) + 4);
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
    g.strokeStyle = 'rgba(255,255,255,0.6)'; g.lineWidth = 1;
    g.beginPath(); g.arc(X(camera.x), Z(camera.z), 6, 0, Math.PI * 2); g.stroke();
  }
}
