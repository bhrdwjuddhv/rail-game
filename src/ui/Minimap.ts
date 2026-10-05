import { newFrame } from '../track/Chainage';
import type { Route } from '../track/Route';

/** Route map with stations, structures and train positions. M toggles a large view. */
export class Minimap {
  readonly canvas = document.createElement('canvas');
  private g: CanvasRenderingContext2D;
  private pts: { x: number; z: number }[] = [];
  private bounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  large = false;

  constructor(parent: HTMLElement, private route: Route) {
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

  draw(trains: { km: number; player: boolean }[], camera: { x: number; z: number }) {
    const g = this.g, S = this.canvas.width;
    const b = this.bounds, pad = 14;
    const sc = Math.min((S - pad * 2) / (b.maxX - b.minX || 1), (S - pad * 2) / (b.maxZ - b.minZ || 1));
    const X = (x: number) => pad + (x - b.minX) * sc + ((S - pad * 2) - (b.maxX - b.minX) * sc) / 2;
    const Z = (z: number) => pad + (z - b.minZ) * sc + ((S - pad * 2) - (b.maxZ - b.minZ) * sc) / 2;
    g.clearRect(0, 0, S, S);
    g.fillStyle = 'rgba(10,14,18,0.75)'; g.fillRect(0, 0, S, S);
    // region colouring along the line
    const f = newFrame();
    g.lineWidth = 3;
    for (let i = 1; i < this.pts.length; i++) {
      const km = (i * 100) / 1000;
      const st = this.route.structureAt(km);
      g.strokeStyle = st?.type === 'tunnel' ? '#6b5a44' : st ? '#9ad' : this.route.ghatFactor(km) > 0.5 ? '#5f9a52' : '#c9b26a';
      g.beginPath(); g.moveTo(X(this.pts[i - 1].x), Z(this.pts[i - 1].z)); g.lineTo(X(this.pts[i].x), Z(this.pts[i].z)); g.stroke();
    }
    g.font = `${this.large ? 13 : 10}px sans-serif`;
    for (const st of this.route.stations) {
      this.route.alignment.sample(st.km * 1000, f);
      g.fillStyle = '#fff'; g.fillRect(X(f.x) - 3, Z(f.z) - 3, 6, 6);
      g.fillText(this.large ? st.name : st.code, X(f.x) + 6, Z(f.z) + 4);
    }
    for (const t of trains) {
      this.route.alignment.sample(t.km * 1000, f);
      g.fillStyle = t.player ? '#ff4d3a' : '#4da3ff';
      g.beginPath(); g.arc(X(f.x), Z(f.z), t.player ? 5 : 4, 0, Math.PI * 2); g.fill();
    }
    g.strokeStyle = 'rgba(255,255,255,0.6)'; g.lineWidth = 1;
    g.beginPath(); g.arc(X(camera.x), Z(camera.z), 6, 0, Math.PI * 2); g.stroke();
  }
}
