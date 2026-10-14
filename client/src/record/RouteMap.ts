import { newFrame } from '@rail/shared/track/Chainage';
import type { Route } from '@rail/shared/track/Route';

export interface MapDot { km: number; colour: string; r: number; ring?: boolean }
export interface MapPath { fromKm: number; toKm: number; colour: string; stops: number[] }

/**
 * Record Mode's route map: stations, trains and their paths; a click gives
 * the surveyed km of the nearest point of the line (placing trains, picking
 * path points). Drawn on demand, never every frame.
 */
export class RouteMap {
  readonly canvas = document.createElement('canvas');
  private g: CanvasRenderingContext2D;
  private pts: { x: number; z: number }[] = [];
  private X = (x: number) => x;
  private Z = (z: number) => z;
  /** a click on the line: surveyed km */
  onPick: ((km: number) => void) | null = null;

  constructor(private route: Route, size = 320) {
    this.canvas.className = 'rec-map';
    this.canvas.width = this.canvas.height = size;
    this.g = this.canvas.getContext('2d')!;
    const f = newFrame();
    for (let s = 0; s <= route.alignment.length; s += 100) { route.alignment.sample(s, f); this.pts.push({ x: f.x, z: f.z }); }
    const xs = this.pts.map(p => p.x), zs = this.pts.map(p => p.z);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs), pad = 12, S = size - pad * 2;
    const sc = Math.min(S / (maxX - minX || 1), S / (maxZ - minZ || 1));
    this.X = x => pad + (x - minX) * sc + (S - (maxX - minX) * sc) / 2;
    this.Z = z => pad + (z - minZ) * sc + (S - (maxZ - minZ) * sc) / 2;
    this.canvas.addEventListener('click', e => {
      const r = this.canvas.getBoundingClientRect();
      const cx = ((e.clientX - r.left) / r.width) * size, cy = ((e.clientY - r.top) / r.height) * size;
      let best = -1, bd = 18 * 18;
      this.pts.forEach((p, i) => { const d = (this.X(p.x) - cx) ** 2 + (this.Z(p.z) - cy) ** 2; if (d < bd) { bd = d; best = i; } });
      if (best >= 0) this.onPick?.(Math.min(route.lengthKm, best / 10));
    });
  }

  private at(km: number) {
    const p = this.pts[Math.max(0, Math.min(this.pts.length - 1, Math.round(km * 10)))];
    return { x: this.X(p.x), y: this.Z(p.z) };
  }

  draw(dots: MapDot[], paths: MapPath[], cam: { x: number; z: number } | null, picking: boolean) {
    const g = this.g, S = this.canvas.width;
    g.clearRect(0, 0, S, S);
    g.fillStyle = 'rgba(12,16,20,0.9)'; g.fillRect(0, 0, S, S);
    g.lineWidth = 3; g.strokeStyle = picking ? '#f0c040' : '#8a8f96';
    g.beginPath();
    this.pts.forEach((p, i) => (i ? g.lineTo(this.X(p.x), this.Z(p.z)) : g.moveTo(this.X(p.x), this.Z(p.z))));
    g.stroke();
    for (const p of paths) {
      g.lineWidth = 5; g.strokeStyle = p.colour; g.globalAlpha = 0.85;
      g.beginPath();
      const a = Math.min(p.fromKm, p.toKm), b = Math.max(p.fromKm, p.toKm);
      for (let km = a; km <= b + 1e-6; km += 0.1) { const q = this.at(km); km === a ? g.moveTo(q.x, q.y) : g.lineTo(q.x, q.y); }
      g.stroke();
      g.globalAlpha = 1;
      for (const km of p.stops) { const q = this.at(km); g.fillStyle = p.colour; g.fillRect(q.x - 3, q.y - 3, 6, 6); }
    }
    g.font = '10px sans-serif';
    for (const st of this.route.stations) {
      const q = this.at(st.km);
      g.fillStyle = '#fff'; g.fillRect(q.x - 2, q.y - 2, 4, 4);
      g.fillText(st.code, q.x + 5, q.y + 3);
    }
    for (const d of dots) {
      const q = this.at(d.km);
      g.fillStyle = d.colour; g.beginPath(); g.arc(q.x, q.y, d.r, 0, Math.PI * 2); g.fill();
      if (d.ring) { g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.arc(q.x, q.y, d.r + 3, 0, Math.PI * 2); g.stroke(); }
    }
    if (cam) { g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 1; g.beginPath(); g.arc(this.X(cam.x), this.Z(cam.z), 6, 0, Math.PI * 2); g.stroke(); }
  }
}
