import * as THREE from 'three/webgpu';
import { WebGLRenderer, WebGLRenderTarget } from 'three';
import { rng } from '@rail/shared/util';
import { GeoBatch } from '../../core/GeoBatch';
import { canvasTexture } from '../../core/Textures';

/**
 * Procedural vegetation: leaf-card trees (neem, mango, ghats forest), palms
 * with drooping fronds, bushes and grass tufts, with their textures drawn in
 * code. Leaf and grass textures are alpha cut-outs whose transparent pixels
 * carry the leaf colour (alpha bleed), so mip-maps never darken the edges.
 * Far trees use impostors baked from these models at start-up.
 */

type Rect = { u0: number; v0: number; u1: number; v1: number };

/**
 * Canvas -> RGBA DataTexture with alpha bleed: pixels under `cut` alpha get
 * the average colour of their cell's opaque pixels. (A canvas stores
 * premultiplied colour, so a transparent pixel's colour would read back black;
 * the DataTexture keeps it.) Rows stay in canvas order: v = y / height.
 */
function bled(c: HTMLCanvasElement, cells: [number, number], cut = 100) {
  const w = c.width, h = c.height;
  const data = c.getContext('2d')!.getImageData(0, 0, w, h).data;
  const cw = w / cells[0], ch = h / cells[1];
  for (let cy = 0; cy < cells[1]; cy++) for (let cx = 0; cx < cells[0]; cx++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = cy * ch; y < (cy + 1) * ch; y++) for (let x = cx * cw; x < (cx + 1) * cw; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] > 200) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
    }
    if (!n) continue;
    r /= n; g /= n; b /= n;
    for (let y = cy * ch; y < (cy + 1) * ch; y++) for (let x = cx * cw; x < (cx + 1) * cw; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < cut) { data[i] = r; data[i + 1] = g; data[i + 2] = b; }
    }
  }
  const t = new THREE.DataTexture(new Uint8Array(data.buffer), w, h, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { c, g: c.getContext('2d', { willReadFrequently: true })! };
}

const ellipse = (g: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, a: number) => {
  g.beginPath(); g.ellipse(x, y, rx, ry, a, 0, Math.PI * 2); g.fill();
};

/** Foliage atlas cells (2 x 2, 256 px): neem, mango, ghats forest, palm frond. */
export const LEAF_CELL: Record<'neem' | 'mango' | 'forest' | 'frond', Rect> = {
  neem: { u0: 0, v0: 0, u1: 0.5, v1: 0.5 }, mango: { u0: 0.5, v0: 0, u1: 1, v1: 0.5 },
  forest: { u0: 0, v0: 0.5, u1: 0.5, v1: 1 }, frond: { u0: 0.5, v0: 0.5, u1: 1, v1: 1 },
};

let leafTex: THREE.Texture | null = null;
export function leafAtlas() {
  if (leafTex) return leafTex;
  const S = 256, { c, g } = canvas(S * 2, S * 2), r = rng(41);
  const green = (lo: number, hi: number, warm = 0) => { const v = lo + r() * (hi - lo); return `rgb(${Math.round(v * (0.52 + warm))},${Math.round(v)},${Math.round(v * 0.32)})`; };
  // a cluster of leaves on twigs, kept inside a soft round silhouette
  const cluster = (ox: number, oy: number, n: number, len: number, wid: number, lo: number, hi: number, warm: number) => {
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * S * 0.42;
      const x = ox + S / 2 + Math.cos(a) * d, y = oy + S / 2 + Math.sin(a) * d;
      g.fillStyle = green(lo, hi, warm);
      ellipse(g, x, y, wid * (0.7 + r() * 0.5), len * (0.7 + r() * 0.5), r() * Math.PI);
    }
  };
  // neem: many small narrow leaflets, light green
  cluster(0, 0, 900, 7, 2.2, 95, 165, 0);
  // mango: large elongated leathery leaves, dark green with some bronze young leaves
  cluster(S, 0, 260, 17, 5, 55, 105, 0);
  for (let i = 0; i < 18; i++) { g.fillStyle = `rgb(${120 + r() * 40},${80 + r() * 30},${40})`; ellipse(g, S + S / 2 + (r() - 0.5) * S * 0.7, S / 2 + (r() - 0.5) * S * 0.7, 4, 14, r() * Math.PI); }
  // ghats forest: dense, dark, mixed sizes
  cluster(0, S, 520, 11, 3.6, 40, 95, -0.05);
  // palm frond: rachis from the bottom of the cell (base) to the top (tip), leaflets angled toward the tip
  const fx = S + S / 2;
  g.strokeStyle = '#7a6a3a'; g.lineWidth = 4;
  g.beginPath(); g.moveTo(fx, S * 2); g.lineTo(fx, S + 4); g.stroke();
  for (let y = S * 2 - 10; y > S + 8; y -= 5) {
    const t = (S * 2 - y) / S, L = (S * 0.46) * Math.sin(Math.PI * Math.min(1, t * 1.05 + 0.08));
    for (const side of [-1, 1]) {
      g.strokeStyle = green(70, 135, 0.05); g.lineWidth = 3;
      g.beginPath(); g.moveTo(fx, y); g.quadraticCurveTo(fx + side * L * 0.6, y - 6, fx + side * L, y - 16 - L * 0.15); g.stroke();
    }
  }
  return (leafTex = bled(c, [2, 2]));
}

let grassTex: THREE.Texture | null = null;
/** Grass blades texture: tapered blades, yellow-green, alpha cut-out with bleed. */
export function grassTexture() {
  if (grassTex) return grassTex;
  const S = 128, { c, g } = canvas(S, S), r = rng(43);
  for (let i = 0; i < 70; i++) {
    const x = 10 + r() * (S - 20), lean = (r() - 0.5) * 50, top = 8 + r() * 50;
    // olive to straw: matches dry plains as well as green fields (instances add a ground tint)
    const v = 80 + r() * 75, dry = r();
    g.fillStyle = `rgb(${Math.round(v * (0.72 + dry * 0.3))},${Math.round(v)},${Math.round(v * (0.36 + dry * 0.12))})`;
    g.beginPath(); g.moveTo(x - 2.2, S); g.quadraticCurveTo(x + lean * 0.35, S * 0.55, x + lean, top); g.quadraticCurveTo(x + lean * 0.35 + 1.5, S * 0.55, x + 2.2, S); g.fill();
  }
  return (grassTex = bled(c, [1, 1]));
}

/** Bark: vertical fissures, repeats (UVs in metres). */
export const barkTexture = () => canvasTexture('bark', 128, 256, (g, w, h) => {
  g.fillStyle = '#8c7760'; g.fillRect(0, 0, w, h);
  const r = rng(47);
  for (let i = 0; i < 90; i++) {
    const x = r() * w, v = 70 + r() * 70;
    g.strokeStyle = `rgb(${v},${v * 0.8},${v * 0.6})`; g.lineWidth = 1 + r() * 3;
    g.beginPath(); g.moveTo(x, 0);
    for (let y = 0; y <= h; y += 16) g.lineTo(x + Math.sin(y * 0.05 + i) * 3, y);
    g.stroke();
  }
});

// ---------------------------------------------------------------- geometry

const _q = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0), _d = new THREE.Vector3();

/** Tapered branch from a to e (bark). */
function limb(b: GeoBatch, a: THREE.Vector3, e: THREE.Vector3, r0: number, r1: number) {
  _d.subVectors(e, a);
  const len = _d.length();
  _q.setFromUnitVectors(_up, _d.normalize());
  const m = new THREE.Matrix4().compose(a.clone().addScaledVector(_d, len / 2), _q, new THREE.Vector3(1, 1, 1));
  b.cyl(r1, r0, len, 6, m, '#ffffff', 'bark');
}

/**
 * A leaf card: a square quad (both sides as separate faces, so no normal flip)
 * at `p`, randomly turned, its normals pointing out from the canopy centre so
 * the crown shades like one soft volume.
 */
function card(b: GeoBatch, p: THREE.Vector3, size: number, cell: Rect, centre: THREE.Vector3, r: () => number, shade: number) {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler((r() - 0.5) * 1.2, r() * Math.PI * 2, (r() - 0.5) * 1.2));
  const ax = new THREE.Vector3(size / 2, 0, 0).applyQuaternion(q), ay = new THREE.Vector3(0, size / 2, 0).applyQuaternion(q);
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => p.clone().addScaledVector(ax, u).addScaledVector(ay, v));
  const pos: number[] = [], nor: number[] = [], uv: number[] = [];
  const uvs = [[cell.u0, cell.v1], [cell.u1, cell.v1], [cell.u1, cell.v0], [cell.u0, cell.v0]];
  corners.forEach((c, i) => {
    pos.push(c.x, c.y, c.z);
    const n = c.clone().sub(centre).normalize().lerp(_up, 0.25).normalize();
    nor.push(n.x, n.y, n.z);
    uv.push(uvs[i][0], uvs[i][1]);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex([0, 1, 2, 0, 2, 3, 0, 2, 1, 0, 3, 2]);
  const v = Math.round(255 * shade);
  b.add(g, null, `rgb(${v},${v},${v})`, 'leaves');
}

/** Leaf cards over an ellipsoid shell; inner cards darker (self-shadowing). */
function crown(b: GeoBatch, centre: THREE.Vector3, rx: number, ry: number, n: number, size: [number, number], cell: Rect, r: () => number) {
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2, el = Math.acos(1 - 1.6 * r()), d = 0.45 + r() * 0.55;
    const p = new THREE.Vector3(Math.sin(el) * Math.cos(a) * rx * d, Math.cos(el) * ry * d, Math.sin(el) * Math.sin(a) * rx * d).add(centre);
    card(b, p, size[0] + r() * (size[1] - size[0]), cell, centre, r, 0.62 + d * 0.38);
  }
}

export type TreeKind = 'mango' | 'neem' | 'forest' | 'palm' | 'bush';

/** Build one tree type into a batch: 'bark' and 'leaves' parts, base at y = 0 (sunk 5 cm). */
export function buildTree(kind: TreeKind, b: GeoBatch) {
  const r = rng({ mango: 51, neem: 52, forest: 53, palm: 54, bush: 55 }[kind]);
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  switch (kind) {
    case 'mango': {
      limb(b, V(0, -0.05, 0), V(0, 2.6, 0), 0.38, 0.3);
      for (const t of [V(1.6, 4.6, 0.4), V(-1.4, 4.4, 0.9), V(0.2, 4.9, -1.5), V(0.1, 5.4, 0.3)]) limb(b, V(0, 2.5, 0), t, 0.24, 0.1);
      crown(b, V(0, 5.3, 0), 3.7, 2.5, 46, [1.9, 2.7], LEAF_CELL.mango, r);
      return;
    }
    case 'neem': {
      limb(b, V(0, -0.05, 0), V(0.2, 3.4, 0), 0.3, 0.22);
      for (const h of [V(-1.5, 5.6, 0.2), V(1.5, 6.2, 0.7), V(0.1, 7.0, -1.1)]) {
        limb(b, V(0.2, 3.3, 0), h, 0.16, 0.06);
        crown(b, h, 2.1, 1.3, 17, [1.4, 2.0], LEAF_CELL.neem, r);
      }
      return;
    }
    case 'forest': {
      limb(b, V(0, -0.05, 0), V(0, 8.5, 0), 0.45, 0.28);
      for (const t of [V(1.8, 10.5, 0.5), V(-1.6, 11, -0.6), V(0.3, 12.2, 1.4)]) limb(b, V(0, 8.2, 0), t, 0.2, 0.08);
      crown(b, V(0, 11.4, 0), 3.8, 3.0, 54, [2.0, 2.9], LEAF_CELL.forest, r);
      return;
    }
    case 'bush':
      crown(b, V(0, 0.9, 0), 1.4, 0.9, 16, [1.0, 1.5], LEAF_CELL.forest, r);
      return;
    case 'palm': {
      // curved trunk: 9 segments leaning out and back up
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 9; i++) { const t = i / 9; pts.push(V(Math.sin(t * 1.4) * 1.1, -0.05 + t * 9.4, 0)); }
      for (let i = 0; i < 9; i++) limb(b, pts[i], pts[i + 1], 0.23 - i * 0.008, 0.22 - (i + 1) * 0.008);
      const top = pts[9];
      // 12 drooping fronds: ribbons bent down along their length, frond image along v
      const cell = LEAF_CELL.frond, N = 6;
      for (let k = 0; k < 12; k++) {
        // young fronds stand up, older ones hang: rise and droop vary per frond
        const age = r(), a = (k / 12) * Math.PI * 2 + (r() - 0.5) * 0.3, L = 3.8 + r() * 1.2, rise = 1.4 - age * 0.9, droop = 2.2 + age * 3.2;
        const dir = V(Math.cos(a), 0, Math.sin(a)), side = V(-Math.sin(a), 0, Math.cos(a));
        const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
        for (let i = 0; i <= N; i++) {
          const t = i / N;
          const c = top.clone().addScaledVector(dir, L * t).add(V(0, rise * t - droop * t * t, 0));
          const w = 0.75 * Math.sin(Math.PI * Math.min(1, t * 1.05 + 0.08)) + 0.08;
          for (const s of [-1, 1]) {
            const p = c.clone().addScaledVector(side, s * w);
            pos.push(p.x, p.y, p.z);
            const n = V(0, 1, 0).addScaledVector(dir, 0.4).normalize();
            nor.push(n.x, n.y, n.z);
            // base of the frond at the bottom of its cell (v1), tip at the top (v0)
            uv.push(s < 0 ? cell.u0 : cell.u1, cell.v1 - (cell.v1 - cell.v0) * t);
          }
          if (i > 0) { const q = (i - 1) * 2; idx.push(q, q + 2, q + 1, q + 1, q + 2, q + 3, q, q + 1, q + 2, q + 1, q + 3, q + 2); }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        g.setIndex(idx);
        b.add(g, null, '#ffffff', 'leaves');
      }
      return;
    }
  }
}

/**
 * Grass tuft: three crossed cards, 0.8 m wide x 0.45 m tall (instances scale
 * 0.6-1.3), sunk 3 cm. Normals point up, so tufts are lit like the ground they
 * grow from; both faces are real triangles (front-side material), so no
 * back-face normal flip darkens half of them.
 */
export function grassTuft() {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI, cx = Math.cos(a) * 0.4, cz = Math.sin(a) * 0.4, base = pos.length / 3;
    // DataTexture rows are in canvas order: blade roots (canvas bottom) are v = 1
    for (const [s, y, u, v] of [[-1, -0.03, 0, 1], [1, -0.03, 1, 1], [1, 0.42, 1, 0], [-1, 0.42, 0, 0]]) {
      pos.push(cx * s, y, cz * s); nor.push(0, 1, 0); uv.push(u, v);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3, base, base + 2, base + 1, base, base + 3, base + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** Height and width of a tree type's model (impostor quad size). */
export function treeSize(kind: TreeKind) {
  const b = new GeoBatch();
  buildTree(kind, b);
  const box = new THREE.Box3();
  for (const k of ['bark', 'leaves']) { const g = b.geometry(k); if (g) { g.computeBoundingBox(); box.union(g.boundingBox!); } }
  return { w: Math.max(box.max.x - box.min.x, box.max.z - box.min.z), h: box.max.y, cx: (box.max.x + box.min.x) / 2 };
}

let bakeRenderer: unknown = null;
/** The renderer impostors are baked with (set once at start-up). */
export function setVegetationRenderer(r: unknown) { bakeRenderer = r; }

/**
 * Impostor textures baked from the near models (classic WebGL): an unlit
 * side view of the broadleaf and palm models into 256 px render targets with
 * leaf-coloured transparent background (no dark fringes), mip-mapped. The
 * impostor material lights it like the near tree. Returns null on WebGPU.
 */
export function bakeImpostors(): Record<'broadleaf' | 'palm', THREE.Texture> | null {
  const r = bakeRenderer as WebGLRenderer | null;
  if (!r) return null;
  if (!(r as { isWebGLRenderer?: boolean }).isWebGLRenderer) return null;
  const out = {} as Record<'broadleaf' | 'palm', THREE.Texture>;
  const leafMat = new THREE.MeshBasicMaterial({ map: leafAtlas(), vertexColors: true, alphaTest: 0.45 });
  const barkMat = new THREE.MeshBasicMaterial({ map: barkTexture(), vertexColors: true });
  const prevTarget = r.getRenderTarget(), prevClear = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
  for (const [key, kind] of [['broadleaf', 'mango'], ['palm', 'palm']] as const) {
    const b = new GeoBatch();
    buildTree(kind, b);
    const { w, h, cx } = treeSize(kind);
    const scene = new THREE.Scene();
    for (const [k, m] of [['bark', barkMat], ['leaves', leafMat]] as const) { const g = b.geometry(k); if (g) scene.add(new THREE.Mesh(g, m)); }
    const cam = new THREE.OrthographicCamera(cx - w / 2, cx + w / 2, h, 0, 0.1, 200);
    cam.position.set(0, 0, 60); cam.lookAt(0, 0, 0);
    const rt = new WebGLRenderTarget(256, 256, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
    rt.texture.colorSpace = THREE.SRGBColorSpace;
    r.setRenderTarget(rt as never);
    r.setClearColor(key === 'palm' ? 0x4f6a2c : 0x3e5a26, 0);
    r.clear();
    r.render(scene as never, cam as never);
    out[key] = rt.texture as unknown as THREE.Texture;
    for (const m of scene.children) (m as THREE.Mesh).geometry.dispose();
  }
  r.setRenderTarget(prevTarget);
  r.setClearColor(prevClear, prevAlpha);
  leafMat.dispose(); barkMat.dispose();
  return out;
}

