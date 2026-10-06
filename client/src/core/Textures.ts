import * as THREE from 'three/webgpu';
import { rng } from '@rail/shared/util';

// Procedural canvas textures. Cached by key so each is generated once.

const cache = new Map<string, THREE.Texture>();
let maxAniso = 8;
export const setMaxAnisotropy = (a: number) => { maxAniso = a; };

export function canvasTexture(key: string, w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, opts: { repeat?: boolean; srgb?: boolean; mips?: boolean } = {}) {
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  if (opts.repeat !== false) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = opts.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  t.anisotropy = maxAniso;
  if (opts.mips === false) { t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; }
  cache.set(key, t);
  return t;
}

function speckle(g: CanvasRenderingContext2D, w: number, h: number, seed: number, n: number, colors: string[], rMin: number, rMax: number) {
  const r = rng(seed);
  for (let i = 0; i < n; i++) {
    g.fillStyle = colors[Math.floor(r() * colors.length)];
    const s = rMin + r() * (rMax - rMin);
    const x = r() * w, y = r() * h;
    g.beginPath(); g.arc(x, y, s, 0, Math.PI * 2); g.fill();
    // wrap
    if (x < s) { g.beginPath(); g.arc(x + w, y, s, 0, Math.PI * 2); g.fill(); }
    if (y < s) { g.beginPath(); g.arc(x, y + h, s, 0, Math.PI * 2); g.fill(); }
  }
}

export const tex = {
  ground: () => canvasTexture('ground', 256, 256, (g, w, h) => {
    g.fillStyle = '#b8b8b8'; g.fillRect(0, 0, w, h);
    speckle(g, w, h, 1, 2600, ['#a6a6a6', '#c9c9c9', '#9a9a9a', '#d6d6d6', '#8f8f8f'], 0.6, 2.2);
  }),
  ballast: () => canvasTexture('ballast', 256, 256, (g, w, h) => {
    g.fillStyle = '#7a756d'; g.fillRect(0, 0, w, h);
    speckle(g, w, h, 2, 3500, ['#5f5a54', '#8e8880', '#a49d94', '#6d6862', '#4e4a46', '#9a8d7a'], 1.2, 3.2);
  }),
  concrete: () => canvasTexture('concrete', 128, 128, (g, w, h) => {
    g.fillStyle = '#a7a39c'; g.fillRect(0, 0, w, h);
    speckle(g, w, h, 3, 900, ['#999590', '#b4b0a9', '#8f8b86'], 0.5, 1.4);
  }),
  brick: () => canvasTexture('brick', 256, 256, (g, w, h) => {
    g.fillStyle = '#d9cfc0'; g.fillRect(0, 0, w, h);
    const r = rng(4);
    for (let y = 0; y < h; y += 16) for (let x = -32; x < w; x += 32) {
      const off = (y / 16) % 2 ? 16 : 0;
      const v = 150 + r() * 40;
      g.fillStyle = `rgb(${v + 30},${v * 0.55},${v * 0.42})`;
      g.fillRect(x + off + 1, y + 1, 30, 14);
    }
  }),
  stone: () => canvasTexture('stone', 256, 256, (g, w, h) => {
    g.fillStyle = '#5c5a55'; g.fillRect(0, 0, w, h);
    const r = rng(5);
    for (let y = 0; y < h; y += 28) for (let x = -40; x < w; x += 40) {
      const v = 110 + r() * 50;
      g.fillStyle = `rgb(${v},${v * 0.96},${v * 0.9})`;
      g.fillRect(x + ((y / 28) % 2 ? 20 : 0) + 2, y + 2, 36 + r() * 3, 24);
    }
  }),
  tunnel: () => canvasTexture('tunnel', 256, 256, (g, w, h) => {
    g.fillStyle = '#3b3833'; g.fillRect(0, 0, w, h);
    speckle(g, w, h, 6, 2000, ['#2c2a26', '#4a4640', '#34312c', '#56514a'], 1, 4);
  }),
  roof: () => canvasTexture('roof', 128, 128, (g, w, h) => {
    for (let y = 0; y < h; y += 8) { g.fillStyle = y % 16 ? '#8c3b2a' : '#7a3123'; g.fillRect(0, y, w, 8); }
  }),
  metalSheet: () => canvasTexture('metalSheet', 128, 128, (g, w, h) => {
    g.fillStyle = '#9aa0a4'; g.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 8) { g.fillStyle = '#80868a'; g.fillRect(x, 0, 2, h); }
  }),
  /** Platform edge strip (u along the platform): concrete top, yellow line, tactile band, edge face. */
  platformEdge: () => canvasTexture('platformEdge', 256, 128, (g, w, h) => {
    g.fillStyle = '#9e9a93'; g.fillRect(0, 0, w, h * 0.5);
    g.fillStyle = '#e5b81e'; g.fillRect(0, h * 0.5, w, h * 0.1);
    g.fillStyle = '#b5b0a6'; g.fillRect(0, h * 0.6, w, h * 0.22);
    g.fillStyle = '#8f8a82';
    for (let x = 4; x < w; x += 8) for (let y = h * 0.62; y < h * 0.8; y += 8) { g.beginPath(); g.arc(x, y + 3, 1.6, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = '#7c7871'; g.fillRect(0, h * 0.82, w, h * 0.18);
  }),
  /** Blank station name board on two posts (transparent around it); the name is drawn on top. */
  nameboard: () => canvasTexture('nameboard', 256, 256, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#e8b416';
    g.fillRect(w * 0.06, h * 0.1, w * 0.06, h * 0.82); g.fillRect(w * 0.88, h * 0.1, w * 0.06, h * 0.82);
    g.fillRect(w * 0.12, h * 0.18, w * 0.76, h * 0.34);
    g.fillStyle = '#111'; g.fillRect(w * 0.06, h * 0.84, w * 0.06, h * 0.08); g.fillRect(w * 0.88, h * 0.84, w * 0.06, h * 0.08);
  }, { repeat: false }),
  /** Building facade: windows in a grid; alpha-less, emissive variant lights windows at night. */
  facade: (lit: boolean) => canvasTexture(`facade${lit}`, 128, 128, (g, w, h) => {
    g.fillStyle = lit ? '#000000' : '#ffffff'; g.fillRect(0, 0, w, h);
    const r = rng(lit ? 7 : 8);
    for (let y = 8; y < h; y += 32) for (let x = 8; x < w; x += 32) {
      if (lit) {
        const on = r() < 0.55;
        g.fillStyle = on ? (r() < 0.5 ? '#ffd890' : '#e8f0ff') : '#000';
      } else g.fillStyle = '#39424a';
      g.fillRect(x, y, 16, 18);
    }
  }),
  glow: () => canvasTexture('glow', 64, 64, (g, w, h) => {
    const grd = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
  }, { repeat: false }),
  cloud: () => canvasTexture('cloud', 512, 512, (g, w, h) => {
    const r = rng(9);
    g.clearRect(0, 0, w, h);
    for (let i = 0; i < 70; i++) {
      const x = r() * w, y = r() * h, s = 20 + r() * 70;
      const grd = g.createRadialGradient(x, y, 0, x, y, s);
      grd.addColorStop(0, 'rgba(255,255,255,0.35)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      for (const dx of [-w, 0, w]) for (const dy of [-h, 0, h]) { g.save(); g.translate(dx, dy); g.fillRect(x - s, y - s, s * 2, s * 2); g.restore(); }
    }
  }),
  /** Billboard tree for impostors (alpha tested). */
  treeImpostor: () => canvasTexture('treeImp', 128, 128, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#5a3d22'; g.fillRect(w / 2 - 5, h * 0.55, 10, h * 0.45);
    const r = rng(10);
    for (let i = 0; i < 160; i++) {
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 46;
      const v = 60 + r() * 70;
      g.fillStyle = `rgb(${v * 0.55},${v},${v * 0.4})`;
      g.beginPath(); g.arc(w / 2 + Math.cos(a) * d, 52 + Math.sin(a) * d * 0.8, 6 + r() * 6, 0, Math.PI * 2); g.fill();
    }
  }, { repeat: false }),
  grass: () => canvasTexture('grass', 64, 64, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    const r = rng(11);
    for (let i = 0; i < 40; i++) {
      const x = 4 + r() * (w - 8), lean = (r() - 0.5) * 16;
      const v = 90 + r() * 80;
      g.strokeStyle = `rgb(${v * 0.6},${v},${v * 0.35})`; g.lineWidth = 2;
      g.beginPath(); g.moveTo(x, h); g.quadraticCurveTo(x + lean * 0.3, h * 0.5, x + lean, 6 + r() * 20); g.stroke();
    }
  }, { repeat: false }),
  waterfall: () => canvasTexture('waterfall', 64, 256, (g, w, h) => {
    g.fillStyle = 'rgba(220,235,240,0.5)'; g.fillRect(0, 0, w, h);
    const r = rng(12);
    for (let i = 0; i < 120; i++) {
      g.fillStyle = `rgba(255,255,255,${0.3 + r() * 0.5})`;
      g.fillRect(r() * w, r() * h, 1 + r() * 3, 10 + r() * 40);
    }
  }),
};

/** Text board (km posts, station names, signs). Cached by content. */
export function labelTexture(text: string, opts: { bg?: string; fg?: string; w?: number; h?: number; font?: string; border?: string; lines?: string[] } = {}) {
  const w = opts.w ?? 256, h = opts.h ?? 128;
  const key = `label:${text}:${opts.bg}:${opts.fg}:${w}x${h}:${opts.font}:${opts.border}:${(opts.lines ?? []).join('|')}`;
  return canvasTexture(key, w, h, (g) => {
    g.fillStyle = opts.bg ?? '#f5d000'; g.fillRect(0, 0, w, h);
    if (opts.border) { g.strokeStyle = opts.border; g.lineWidth = Math.max(3, h * 0.05); g.strokeRect(g.lineWidth / 2, g.lineWidth / 2, w - g.lineWidth, h - g.lineWidth); }
    g.fillStyle = opts.fg ?? '#111';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const lines = opts.lines ?? [text];
    const lh = h / lines.length;
    lines.forEach((ln, i) => {
      let size = Math.floor(lh * 0.62);
      const family = opts.font ?? `"Nirmala UI", "Noto Sans", "Noto Sans Devanagari", "Noto Sans Gujarati", "Noto Sans Kannada", Arial, sans-serif`;
      g.font = `bold ${size}px ${family}`;
      while (g.measureText(ln).width > w * 0.92 && size > 8) { size -= 2; g.font = `bold ${size}px ${family}`; }
      g.fillText(ln, w / 2, lh * (i + 0.5));
    });
  }, { repeat: false });
}

/**
 * Shelf-packed canvas atlas: many small labels/dials share one texture so
 * their meshes can merge into a single draw call.
 */
export class Atlas {
  readonly canvas = document.createElement('canvas');
  readonly texture: THREE.CanvasTexture;
  private x = 0;
  private y = 0;
  private rowH = 0;
  constructor(readonly w: number, readonly h: number) {
    this.canvas.width = w; this.canvas.height = h;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = maxAniso;
  }
  /** Reserve a w x h cell, draw into it (origin at the cell's top-left), return its UV rect. */
  add(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
    if (this.x + w > this.w) { this.x = 0; this.y += this.rowH + 2; this.rowH = 0; }
    if (this.y + h > this.h) throw new Error('Atlas full');
    const g = this.canvas.getContext('2d')!;
    g.save(); g.translate(this.x, this.y); g.beginPath(); g.rect(0, 0, w, h); g.clip(); draw(g); g.restore();
    const r = { u0: this.x / this.w, v0: 1 - (this.y + h) / this.h, u1: (this.x + w) / this.w, v1: 1 - this.y / this.h };
    this.x += w + 2;
    this.rowH = Math.max(this.rowH, h);
    this.texture.needsUpdate = true;
    return r;
  }
}

/** Remap a geometry's 0..1 UVs into an atlas rect. */
export function uvToRect(g: THREE.BufferGeometry, r: { u0: number; v0: number; u1: number; v1: number }) {
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, r.u0 + uv.getX(i) * (r.u1 - r.u0), r.v0 + uv.getY(i) * (r.v1 - r.v0));
  return g;
}
