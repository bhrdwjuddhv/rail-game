import type { BlockSystem } from '@rail/shared/signalling/BlockSystem';
import type { Route } from '@rail/shared/track/Route';

/** Strip showing the next ~3 km: elevation profile, curves, speed limits, signals, stations. */
export class TrackProfile {
  readonly canvas = document.createElement('canvas');
  private g: CanvasRenderingContext2D;
  rangeKm = 3;

  constructor(parent: HTMLElement) {
    this.canvas.className = 'track-profile';
    this.canvas.width = 640; this.canvas.height = 110;
    this.g = this.canvas.getContext('2d')!;
    parent.appendChild(this.canvas);
  }

  draw(route: Route, block: BlockSystem, headKm: number, limitAt: (km: number) => number, pathOffset: (km: number) => number) {
    const g = this.g, W = 640, H = 110;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(10,14,18,0.72)'; g.fillRect(0, 0, W, H);
    const k0 = headKm - 0.2, k1 = headKm + this.rangeKm;
    const X = (km: number) => ((km - k0) / (k1 - k0)) * W;
    const a = route.alignment;
    // elevation
    let lo = Infinity, hi = -Infinity;
    for (let km = k0; km <= k1; km += 0.05) { const e = a.elevationAt(km); lo = Math.min(lo, e); hi = Math.max(hi, e); }
    const span = Math.max(8, hi - lo);
    const Y = (e: number) => 70 - ((e - lo) / span) * 40;
    g.beginPath(); g.moveTo(0, H);
    for (let km = k0; km <= k1; km += 0.025) g.lineTo(X(km), Y(a.elevationAt(km)));
    g.lineTo(W, H); g.closePath();
    g.fillStyle = 'rgba(120,150,110,0.35)'; g.fill();
    g.strokeStyle = '#9fd18b'; g.lineWidth = 1.5; g.beginPath();
    for (let km = k0; km <= k1; km += 0.025) { const x = X(km), y = Y(a.elevationAt(km)); km === k0 ? g.moveTo(x, y) : g.lineTo(x, y); }
    g.stroke();
    // curves band
    for (let km = k0; km < k1; km += 0.02) {
      const k = a.curvatureAt(km);
      if (Math.abs(k) < 1 / 3000) continue;
      g.fillStyle = k > 0 ? 'rgba(90,170,255,0.8)' : 'rgba(255,170,80,0.8)';
      g.fillRect(X(km), 96, Math.max(1, X(km + 0.02) - X(km)), Math.min(10, Math.abs(k) * 4000));
    }
    // structures
    for (const s of route.data.structures) {
      if (s.toKm < k0 || s.fromKm > k1) continue;
      g.fillStyle = s.type === 'tunnel' ? 'rgba(80,60,40,0.8)' : 'rgba(160,160,170,0.8)';
      g.fillRect(X(s.fromKm), 84, X(s.toKm) - X(s.fromKm), 8);
    }
    // speed limit step line
    g.strokeStyle = '#ffcf4a'; g.lineWidth = 2; g.beginPath();
    const SY = (v: number) => 34 - (v / 140) * 28;
    let prev = -1;
    for (let km = k0; km <= k1; km += 0.01) {
      const v = limitAt(km);
      const x = X(km), y = SY(v);
      if (prev < 0) g.moveTo(x, y); else if (v !== prev) { g.lineTo(x, SY(prev)); g.lineTo(x, y); }
      prev = v;
    }
    g.lineTo(W, SY(prev)); g.stroke();
    g.fillStyle = '#ffcf4a'; g.font = '11px sans-serif';
    let last = -1;
    for (let km = k0; km <= k1; km += 0.01) { const v = limitAt(km); if (v !== last) { g.fillText(String(v), X(km) + 2, SY(v) - 3); last = v; } }
    // stations
    g.font = 'bold 11px sans-serif';
    for (const st of route.stations) {
      if (st.platformToKm < k0 || st.platformFromKm > k1) continue;
      g.fillStyle = 'rgba(255,255,255,0.18)';
      g.fillRect(X(st.platformFromKm), 0, X(st.platformToKm) - X(st.platformFromKm), H);
      g.fillStyle = '#fff'; g.fillText(st.code, X(st.platformFromKm) + 2, 48);
    }
    // signals
    for (const s of block.signals) {
      if (s.km < k0 || s.km > k1) continue;
      if (Math.abs(pathOffset(s.km) - s.def.offset) > 0.5) continue;
      const x = X(s.km);
      g.fillStyle = '#ddd'; g.fillRect(x - 0.5, 52, 1, 30);
      const c = s.aspect === 'R' ? '#ff3b30' : s.aspect === 'G' ? '#34ff7a' : '#ffcc00';
      g.fillStyle = c; g.beginPath(); g.arc(x, 52, 4, 0, Math.PI * 2); g.fill();
      if (s.aspect === 'YY') { g.beginPath(); g.arc(x, 62, 4, 0, Math.PI * 2); g.fill(); }
    }
    // train head marker
    g.fillStyle = '#fff'; g.fillRect(X(headKm) - 1, 0, 2, H);
    g.fillText('YOU', X(headKm) + 3, 106);
  }
}
