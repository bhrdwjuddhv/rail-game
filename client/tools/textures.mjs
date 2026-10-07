// Texture pipeline: `npm run textures`  (options: --only <id-substring> --force --selftest)
//
// For every entry in data/textures.json whose source image exists under client/public/assets/:
//  1. validate (PNG, size, alpha, painted-in "fake transparency" checkerboards)
//  2. power-of-two size from the manifest; crop (tiles) or pad (sprites/decals/atlases), never stretch
//  3. de-light tileable colour maps (divide out large-scale brightness, keep fine detail)
//  4. make tile / tile-x / tile-y seamless along their wrap axes, then score the seams
//  5. normalise brightness/saturation into the entry's colour group range
//  6. atlases: per-cell content bounds, border-touch warnings, gutter repair, UV rects (half-pixel inset)
//  7. alpha images: remove faint alpha noise, bleed edge colours into transparent texels (no halos)
//  8. tileable surfaces: height (high-passed luminance) -> normal (Sobel, wrap-around) + roughness
//  9-10. export KTX2 (Basis Universal, mipmapped; the main format) + WebP fallback, for every size the
//     presets need, into client/public/assets/textures/_processed/, and record it in the manifest
//  11. print a summary table and estimated GPU memory per preset
// Results are cached by content hash: unchanged sources are not re-encoded.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { encodeToKTX2 } from 'ktx2-encoder';

const PIPELINE_VERSION = 3;
const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.resolve(ROOT, '../data/textures.json');
const ASSETS = path.join(ROOT, 'public/assets');
const OUT_REL = 'textures/_processed';
const OUT = path.join(ASSETS, OUT_REL);
const CACHE_FILE = path.join(OUT, '.cache.json');
const TILE_TYPES = new Set(['tile', 'tile-x', 'tile-y']);
const SEAM_WARN = 1.6;

// ------------------------------------------------------------------ image helpers (RGBA Float32 0..255)
const lum = (p, i) => 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = t => t * t * (3 - 2 * t);
async function toRaw(img) {
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { px: Float32Array.from(data), w: info.width, h: info.height };
}
const toU8 = px => { const o = Buffer.alloc(px.length); for (let i = 0; i < px.length; i++) o[i] = clamp(Math.round(px[i]), 0, 255); return o; };
const rawSharp = (px, w, h) => sharp(toU8(px), { raw: { width: w, height: h, channels: 4 } });

/** Gaussian blur of a single channel with mirrored edges (sharp), returned as Float32 0..255. */
async function blurChannel(ch, w, h, sigma) {
  const pad = Math.min(Math.ceil(sigma * 3), Math.min(w, h) - 1);
  const u8 = Buffer.alloc(w * h);
  for (let i = 0; i < ch.length; i++) u8[i] = clamp(Math.round(ch[i]), 0, 255);
  // sharp runs its operations in a fixed order, so pad + blur and the crop are two passes
  const blurred = await sharp(u8, { raw: { width: w, height: h, channels: 1 } })
    .extend({ top: pad, bottom: pad, left: pad, right: pad, extendWith: 'mirror' }).blur(sigma).raw().toBuffer({ resolveWithObject: true });
  const { data } = await sharp(blurred.data, { raw: { width: blurred.info.width, height: blurred.info.height, channels: 1 } })
    .extract({ left: pad, top: pad, width: w, height: h }).raw().toBuffer({ resolveWithObject: true });
  return Float32Array.from(data);
}

// ------------------------------------------------------------------ 1. validation
/**
 * Painted-in transparency: an opaque image whose background is the grey/white
 * checkerboard image editors use to show alpha. Samples the four corners: the
 * pixels must be near-grey and split into two clear luminance levels that
 * alternate in squares.
 */
export function fakeTransparency(px, w, h) {
  const n = Math.min(96, w >> 2, h >> 2);
  let hits = 0;
  for (const [ox, oy] of [[0, 0], [w - n, 0], [0, h - n], [w - n, h - n]]) {
    const vals = [];
    let grey = 0;
    for (let y = oy; y < oy + n; y++) for (let x = ox; x < ox + n; x++) {
      const i = (y * w + x) * 4;
      const mx = Math.max(px[i], px[i + 1], px[i + 2]), mn = Math.min(px[i], px[i + 1], px[i + 2]);
      if (mx - mn < 12 && mx > 150) grey++;
      vals.push(lum(px, i));
    }
    if (grey < n * n * 0.92) continue;
    const sorted = [...vals].sort((a, b) => a - b);
    const lo = sorted[Math.floor(vals.length * 0.25)], hi = sorted[Math.floor(vals.length * 0.75)];
    if (hi - lo < 18) continue; // one flat colour: a plain background, not a checkerboard
    // alternation: along a row the level flips at a regular period
    const mid = (lo + hi) / 2;
    let flips = 0;
    for (let x = 1; x < n; x++) if ((vals[x] > mid) !== (vals[x - 1] > mid)) flips++;
    if (flips >= 3 && flips <= n / 3) hits++;
  }
  return hits >= 2;
}

// ------------------------------------------------------------------ 3. de-light
/** Divide out large-scale brightness (dark corners, hot spots) and restore the average level. */
async function delight(px, w, h) {
  const L = new Float32Array(w * h);
  let mean = 0;
  for (let i = 0; i < w * h; i++) { L[i] = lum(px, i * 4); mean += L[i]; }
  mean /= w * h;
  const B = await blurChannel(L, w, h, Math.max(w, h) / 6);
  for (let i = 0; i < w * h; i++) {
    const f = clamp(mean / Math.max(1, B[i]), 0.6, 1.6);
    for (let c = 0; c < 3; c++) px[i * 4 + c] *= f;
  }
}

// ------------------------------------------------------------------ 4. seamless + seam score
/**
 * Offset-and-blend: blend with a copy rolled along the wrap axes, with a
 * feathered mask that is 1 at the image border (where the seam would show) and
 * 0 along the rolled copy's own seam. The roll defaults to half the size; for
 * patterned textures (bricks, corrugations, crop rows) it is a whole number of
 * pattern periods (see patternShift), so the blended copies line up and the
 * pattern does not double up in the middle.
 */
export function makeSeamless(px, w, h, ax, sx = w >> 1, sy = h >> 1) {
  const out = new Float32Array(px.length);
  const wx = ax !== 'y', wy = ax !== 'x';
  const cx = w - sx, cy = h - sy; // where the rolled copy wraps (its own seam)
  const circ = (a, b, n) => { const d = Math.abs(a - b) % n; return Math.min(d, n - d); };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dEdge = Math.min(wx ? Math.min(x, w - 1 - x) : Infinity, wy ? Math.min(y, h - 1 - y) : Infinity);
    const dSeam = Math.min(wx ? circ(x, cx, w) : Infinity, wy ? circ(y, cy, h) : Infinity);
    const m = smooth(dSeam / (dSeam + dEdge + 1e-6));
    const rx = wx ? (x + sx) % w : x, ry = wy ? (y + sy) % h : y;
    const i = (y * w + x) * 4, j = (ry * w + rx) * 4;
    for (let c = 0; c < 4; c++) out[i + c] = px[i + c] * (1 - m) + px[j + c] * m;
  }
  return out;
}

/**
 * Roll for makeSeamless along one axis: the shift between 30 % and 70 % of the
 * size where the image best matches itself (autocorrelation on a 256 px grey
 * copy). Textures without a repeating pattern get half the size.
 */
export async function patternShift(px, w, h, axis) {
  const N = 256;
  const { data } = await rawSharp(px, w, h).resize(N, N, { fit: 'fill' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const g = new Float32Array(N * N);
  let mean = 0;
  for (let i = 0; i < N * N; i++) { g[i] = data[i * 4] ?? data[i]; mean += g[i]; }
  mean /= N * N;
  let v0 = 0;
  for (let i = 0; i < N * N; i++) { g[i] -= mean; v0 += g[i] * g[i]; }
  let best = N / 2, bestC = -1;
  for (let d = Math.round(N * 0.3); d <= Math.round(N * 0.7); d++) {
    let c = 0;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const j = axis === 'x' ? y * N + ((x + d) % N) : ((y + d) % N) * N + x;
      c += g[y * N + x] * g[j];
    }
    c /= v0 || 1;
    if (c > bestC) { bestC = c; best = d; }
  }
  const size = axis === 'x' ? w : h;
  return bestC > 0.25 ? Math.round((best * size) / N) : size >> 1;
}

/**
 * Seam score along the wrap axes: mean colour step across the wrap edge divided
 * by the larger of two interior steps (the middle column is untouched by the
 * blend, so it keeps full contrast). ~1 = invisible seam.
 */
export function seamScore(px, w, h, ax) {
  const step = (i, j) => Math.abs(px[i] - px[j]) + Math.abs(px[i + 1] - px[j + 1]) + Math.abs(px[i + 2] - px[j + 2]);
  let worst = 0;
  if (ax !== 'y') {
    let edge = 0, a = 0, b = 0;
    for (let y = 0; y < h; y++) {
      edge += step((y * w + w - 1) * 4, y * w * 4);
      a += step((y * w + (w >> 1)) * 4, (y * w + (w >> 1) - 1) * 4);
      b += step((y * w + (w >> 2)) * 4, (y * w + (w >> 2) - 1) * 4);
    }
    worst = Math.max(worst, edge / Math.max(1e-6, a, b));
  }
  if (ax !== 'x') {
    let edge = 0, a = 0, b = 0;
    for (let x = 0; x < w; x++) {
      edge += step(((h - 1) * w + x) * 4, x * 4);
      a += step(((h >> 1) * w + x) * 4, (((h >> 1) - 1) * w + x) * 4);
      b += step(((h >> 2) * w + x) * 4, (((h >> 2) - 1) * w + x) * 4);
    }
    worst = Math.max(worst, edge / Math.max(1e-6, a, b));
  }
  return worst;
}

// ------------------------------------------------------------------ 5. colour normalisation
function normalise(px, w, h, range) {
  let L = 0, S = 0, n = 0;
  for (let i = 0; i < w * h; i++) {
    const k = i * 4;
    if (px[k + 3] < 128) continue;
    const mx = Math.max(px[k], px[k + 1], px[k + 2]), mn = Math.min(px[k], px[k + 1], px[k + 2]);
    L += lum(px, k); S += mx > 0 ? (mx - mn) / mx : 0; n++;
  }
  if (!n) return null;
  L /= n; S /= n;
  const gain = L < range.lum[0] ? range.lum[0] / L : L > range.lum[1] ? range.lum[1] / L : 1;
  const sk = S < range.sat[0] ? range.sat[0] / Math.max(0.01, S) : S > range.sat[1] ? range.sat[1] / S : 1;
  if (gain !== 1 || sk !== 1) {
    for (let i = 0; i < w * h; i++) {
      const k = i * 4, g = lum(px, k);
      for (let c = 0; c < 3; c++) px[k + c] = (g + (px[k + c] - g) * sk) * gain;
    }
  }
  return { lum: L, sat: S, gain, satK: sk };
}

// ------------------------------------------------------------------ 7. alpha clean-up and bleed
/** Drop faint alpha noise and snap near-opaque; then push edge colours into transparent texels. */
export function cleanAndBleed(px, w, h, region = { x0: 0, y0: 0, x1: w, y1: h }, passes = 24) {
  for (let i = 3; i < px.length; i += 4) { if (px[i] < 10) px[i] = 0; else if (px[i] > 245) px[i] = 255; }
  const done = new Uint8Array(w * h);
  for (let y = region.y0; y < region.y1; y++) for (let x = region.x0; x < region.x1; x++) if (px[(y * w + x) * 4 + 3] > 0) done[y * w + x] = 1;
  for (let p = 0; p < passes; p++) {
    const add = [];
    for (let y = region.y0; y < region.y1; y++) for (let x = region.x0; x < region.x1; x++) {
      if (done[y * w + x]) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < region.x0 || yy < region.y0 || xx >= region.x1 || yy >= region.y1 || !done[yy * w + xx]) continue;
        const k = (yy * w + xx) * 4; r += px[k]; g += px[k + 1]; b += px[k + 2]; n++;
      }
      if (n) add.push([y * w + x, r / n, g / n, b / n]);
    }
    if (!add.length) break;
    for (const [i, r, g, b] of add) { px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; done[i] = 1; }
  }
}

// ------------------------------------------------------------------ 6. atlases
/** Per-cell content bounds, gutter repair (content scaled into the safe area) and UV rects. */
export async function processAtlas(px, w, h, grid, hasAlpha) {
  const [cols, rows] = grid;
  const cw = w / cols, ch = h / rows;
  const gutter = Math.max(2, Math.round(8 * (w / 1024)));
  const warnings = [], cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x0 = Math.round(c * cw), y0 = Math.round(r * ch), x1 = Math.round((c + 1) * cw), y1 = Math.round((r + 1) * ch);
    let bx0 = x1, by0 = y1, bx1 = x0, by1 = y0;
    if (hasAlpha) {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (px[(y * w + x) * 4 + 3] > 12) { bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x + 1); by1 = Math.max(by1, y + 1); }
    } else { bx0 = x0; by0 = y0; bx1 = x1; by1 = y1; }
    const empty = bx1 <= bx0;
    const touches = !empty && (bx0 - x0 < gutter || by0 - y0 < gutter || x1 - bx1 < gutter || y1 - by1 < gutter);
    if (empty) warnings.push(`cell ${c},${r} is empty`);
    if (touches && hasAlpha) {
      warnings.push(`cell ${c},${r} content reaches the cell border - shrunk to keep a ${gutter} px gutter`);
      const cell = Buffer.alloc((bx1 - bx0) * (by1 - by0) * 4);
      for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) for (let k = 0; k < 4; k++) cell[((y - by0) * (bx1 - bx0) + (x - bx0)) * 4 + k] = clamp(Math.round(px[(y * w + x) * 4 + k]), 0, 255);
      const iw = x1 - x0 - 2 * gutter, ih = y1 - y0 - 2 * gutter;
      const { data, info } = await sharp(cell, { raw: { width: bx1 - bx0, height: by1 - by0, channels: 4 } })
        .resize(iw, ih, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: 'lanczos3' }).raw().toBuffer({ resolveWithObject: true });
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px[(y * w + x) * 4 + 3] = 0;
      for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
        const i = ((y0 + gutter + y) * w + (x0 + gutter + x)) * 4, j = (y * info.width + x) * 4;
        for (let k = 0; k < 4; k++) px[i + k] = data[j + k];
      }
    } else if (touches) {
      warnings.push(`cell ${c},${r}: opaque content runs to the cell border - mipmaps will bleed between cells`);
    }
    if (hasAlpha) cleanAndBleed(px, w, h, { x0, y0, x1, y1 }, gutter * 4);
    // UV rect of the whole cell with a half-texel inset (v = 0 at the bottom, as three.js samples it)
    cells.push([(x0 + 0.5) / w, 1 - (y1 - 0.5) / h, (x1 - 0.5) / w, 1 - (y0 + 0.5) / h].map(v => +v.toFixed(6)));
  }
  return { cells, warnings };
}

// ------------------------------------------------------------------ 8. normal + roughness
/** Height = luminance minus its blur (high-pass); Sobel normal (OpenGL +Y); roughness from inverted, levelled height. */
async function maps(px, w, h, ax, strength, [rMin, rMax]) {
  const L = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) L[i] = lum(px, i * 4);
  const B = await blurChannel(L, w, h, Math.max(4, w / 64));
  const H = new Float32Array(w * h);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < w * h; i++) { H[i] = (L[i] - B[i]) / 255; lo = Math.min(lo, H[i]); hi = Math.max(hi, H[i]); }
  const wx = ax !== 'y', wy = ax !== 'x';
  const at = (x, y) => {
    x = wx ? (x + w) % w : clamp(x, 0, w - 1);
    y = wy ? (y + h) % h : clamp(y, 0, h - 1);
    return H[y * w + x];
  };
  const nrm = new Float32Array(w * h * 4), rough = new Float32Array(w * h * 4);
  const s = strength * (w / 1024) * 4;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const gx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
    const gy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
    let nx = -gx * s, ny = gy * s, nz = 1;
    const len = Math.hypot(nx, ny, nz); nx /= len; ny /= len; nz /= len;
    const i = (y * w + x) * 4;
    nrm[i] = (nx * 0.5 + 0.5) * 255; nrm[i + 1] = (ny * 0.5 + 0.5) * 255; nrm[i + 2] = (nz * 0.5 + 0.5) * 255; nrm[i + 3] = 255;
    // crevices (low) rough, raised highlights smoother, levelled into the material's range
    const t = 1 - (H[y * w + x] - lo) / Math.max(1e-6, hi - lo);
    const r = (rMin + (rMax - rMin) * t) * 255;
    rough[i] = rough[i + 1] = rough[i + 2] = r; rough[i + 3] = 255;
  }
  return { nrm, rough };
}

// ------------------------------------------------------------------ 9-10. export
async function encodeKtx2(px, w, h, kind) {
  const raw = new Uint8Array(toU8(px));
  const color = kind === 'color';
  return encodeToKTX2(raw, {
    isKTX2File: true, generateMipmap: true, isYFlip: true, // same orientation as WebP loaded with flipY
    isUASTC: kind === 'normal', isNormalMap: kind === 'normal', needSupercompression: kind === 'normal',
    qualityLevel: kind === 'normal' ? 128 : 160, compressionLevel: 2,
    isPerceptual: color, isSetKTX2SRGBTransferFunc: color,
    imageDecoder: async () => ({ data: raw, width: w, height: h }),
  });
}

async function writeSet(base, px, w, h, entry, ax, warnings) {
  const out = { size: [w, h] };
  const files = [['color', px]];
  if (entry.normal > 0 && TILE_TYPES.has(entry.type)) {
    const m = await maps(px, w, h, ax, entry.normal, entry.roughness);
    files.push(['normal', m.nrm], ['roughness', m.rough]);
  }
  let bytes = 0;
  for (const [kind, data] of files) {
    const name = `${base}_${w}_${kind}`;
    const webp = path.join(OUT, `${name}.webp`);
    await rawSharp(data, w, h).webp(kind === 'normal' ? { lossless: true, effort: 5 } : { quality: 90, alphaQuality: 100, effort: 5 }).toFile(webp);
    out[kind] = `${OUT_REL}/${name}.webp`;
    try {
      const k = await encodeKtx2(data, w, h, kind);
      fs.writeFileSync(path.join(OUT, `${name}.ktx2`), k);
      out[`${kind}Ktx2`] = `${OUT_REL}/${name}.ktx2`;
      bytes += k.length;
    } catch (e) {
      warnings.push(`KTX2 ${kind} ${w}px failed (${e.message}); WebP only`);
    }
    bytes += fs.statSync(webp).size;
  }
  out.diskBytes = bytes;
  return out;
}

// ------------------------------------------------------------------ one texture
async function processEntry(id, t, groups) {
  const warnings = [];
  const src = path.join(ASSETS, t.file);
  if (!fs.existsSync(src)) return { status: 'missing', warnings: ['no source image (procedural fallback)'] };
  let meta;
  try { meta = await sharp(src).metadata(); } catch (e) { return { status: 'skipped', warnings: [`cannot read image: ${e.message}`] }; }
  if (meta.format !== 'png') return { status: 'skipped', warnings: [`${meta.format} file - expected a PNG source`] };
  if (meta.width < 256 || meta.height < 128) return { status: 'skipped', warnings: [`too small (${meta.width}x${meta.height})`] };
  const ax = t.type === 'tile' ? 'xy' : t.type === 'tile-x' ? 'x' : t.type === 'tile-y' ? 'y' : null;
  const sizes = [...new Set(Object.values(t.maxSize))].sort((a, b) => b - a);
  const L = sizes[0];
  if (Math.max(meta.width, meta.height) < L) warnings.push(`source ${meta.width}x${meta.height} is smaller than ${L} - upscaled`);

  // 2. power-of-two frame: tiles crop to their aspect, everything else pads (transparent) - never stretch
  const aspect = meta.width / meta.height;
  const potAspect = 2 ** Math.round(Math.log2(aspect));
  if (Math.abs(aspect / potAspect - 1) > 0.02) warnings.push(`aspect ${aspect.toFixed(2)} is not a power of two - ${ax ? 'cropped' : 'padded'} to ${potAspect >= 1 ? `${potAspect}:1` : `1:${1 / potAspect}`}`);
  const W = potAspect >= 1 ? L : Math.round(L * potAspect), H = potAspect >= 1 ? Math.round(L / potAspect) : L;
  const img = sharp(src).resize(W, H, ax ? { fit: 'cover', position: 'centre', kernel: 'lanczos3' } : { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: 'lanczos3' });
  let { px, w, h } = await toRaw(img);

  // 1b. alpha checks
  const hasAlpha = !!meta.hasAlpha && !(await sharp(src).stats()).isOpaque;
  if (t.alpha && !hasAlpha) warnings.push(fakeTransparency(px, w, h) ? 'FAKE TRANSPARENCY: checkerboard painted into an opaque image' : 'expected alpha but the image is opaque');
  if (!t.alpha && meta.hasAlpha && !(await sharp(src).stats()).isOpaque) warnings.push('has transparency but the entry is opaque - alpha ignored');
  if (!t.alpha) for (let i = 3; i < px.length; i += 4) px[i] = 255;

  // 3-4. de-light and seamless (tileable colour maps only)
  let seam = null;
  if (ax) {
    const before = seamScore(px, w, h, ax);
    await delight(px, w, h);
    const sx = ax !== 'y' ? await patternShift(px, w, h, 'x') : w >> 1;
    const sy = ax !== 'x' ? await patternShift(px, w, h, 'y') : h >> 1;
    if (sx !== w >> 1 || sy !== h >> 1) warnings.push(`pattern-aligned blend (shift ${sx}, ${sy} px)`);
    px = makeSeamless(px, w, h, ax, sx, sy);
    seam = { before: +before.toFixed(2), after: +seamScore(px, w, h, ax).toFixed(2) };
    if (seam.after > SEAM_WARN) warnings.push(`seam score ${seam.after} after blending (> ${SEAM_WARN}): visible repeat edge`);
  }
  // 5. colour group
  const group = groups[t.group];
  const colour = group ? normalise(px, w, h, group) : null;
  if (colour && (colour.gain < 0.8 || colour.gain > 1.25)) warnings.push(`brightness far from its group (x${colour.gain.toFixed(2)} applied)`);
  // 6-7. atlases and alpha
  let cells;
  if (t.type === 'atlas' && t.grid) {
    const a = await processAtlas(px, w, h, t.grid, t.alpha && hasAlpha);
    cells = a.cells; warnings.push(...a.warnings);
  } else if (t.alpha && hasAlpha) cleanAndBleed(px, w, h);

  // 9-10. export every size the presets use
  const base = id.replace(/\//g, '_');
  const sets = {};
  for (const s of sizes) {
    const sw = Math.round(w * s / L), sh = Math.round(h * s / L);
    let spx = px;
    if (s !== L) ({ px: spx } = await toRaw(rawSharp(px, w, h).resize(sw, sh, { kernel: 'lanczos3' })));
    sets[s] = await writeSet(base, spx, sw, sh, t, ax ?? 'none', warnings);
  }
  const processed = { sizes: sets, ...(cells ? { cells } : {}), ...(seam ? { seam } : {}) };
  return { status: warnings.some(w => w.startsWith('FAKE')) ? 'warn' : 'ok', warnings, processed, seam };
}

// ------------------------------------------------------------------ GPU memory per preset
/** Bytes per texel on the GPU: KTX2 transcodes to block-compressed formats (ETC1S ~0.5-1 B, UASTC 1 B); WebP fallback is RGBA8 (4 B). */
function memoryPerPreset(manifest) {
  const presets = ['high', 'medium', 'low'];
  const res = {};
  for (const q of presets) {
    let ktx = 0, webp = 0;
    for (const t of Object.values(manifest.textures)) {
      const set = t.processed?.sizes?.[t.maxSize[q]];
      if (!set) continue;
      const kinds = ['color', ...(q === 'low' ? [] : ['normal', 'roughness'])].filter(k => set[k]);
      for (const k of kinds) {
        const texels = set.size[0] * set.size[1] * 1.333;
        ktx += texels * (k === 'normal' ? 1 : t.alpha ? 1 : 0.5);
        webp += texels * 4;
      }
    }
    res[q] = { ktx2MB: ktx / 1048576, webpMB: webp / 1048576, budgetMB: manifest.budgetsMB?.[q] };
  }
  return res;
}

// ------------------------------------------------------------------ UI images
async function processUi(name, rel) {
  const pngs = ['.png', '.jpg', '.jpeg'].map(e => path.join(ASSETS, rel + e)).filter(f => fs.existsSync(f));
  if (!pngs.length) return;
  const out = path.join(ASSETS, rel + '.webp');
  await sharp(pngs[0]).resize({ width: 1920, withoutEnlargement: true }).webp({ quality: 82, effort: 5 }).toFile(out);
  console.log(`  ui ${name}: ${path.basename(pngs[0])} -> ${path.basename(out)}`);
}

// ------------------------------------------------------------------ self-test
async function selftest() {
  const assert = (c, m) => { if (!c) throw new Error(`selftest: ${m}`); console.log(`  ok  ${m}`); };
  const W = 256;
  // checkerboard painted into an opaque image is flagged; a plain background is not
  const chk = new Float32Array(W * W * 4), flat = new Float32Array(W * W * 4);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const v = ((x >> 4) + (y >> 4)) % 2 ? 255 : 204, i = (y * W + x) * 4;
    chk.set([v, v, v, 255], i); flat.set([250, 250, 250, 255], i);
  }
  assert(fakeTransparency(chk, W, W), 'checkerboard background flagged as fake transparency');
  assert(!fakeTransparency(flat, W, W), 'plain white background not flagged');
  // a hard left/right gradient has a bad seam; blending fixes it
  const grad = new Float32Array(W * W * 4);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) { const v = 40 + (x / W) * 180 + Math.sin(y * 0.9 + x * 1.3) * 6; grad.set([v, v, v, 255], (y * W + x) * 4); }
  const b = seamScore(grad, W, W, 'x');
  const a = seamScore(makeSeamless(grad, W, W, 'x'), W, W, 'x');
  assert(b > 5 && a < SEAM_WARN, `seam score drops after blending (${b.toFixed(1)} -> ${a.toFixed(2)})`);
  // atlas cell touching its border is shrunk into the gutter
  const at = new Float32Array(W * W * 4);
  for (let y = 0; y < W; y++) for (let x = 0; x < W / 2; x++) at.set([200, 30, 30, 255], (y * W + x) * 4);
  const r = await processAtlas(at, W, W, [2, 1], true);
  assert(r.warnings.some(w => w.includes('cell 0,0') && w.includes('gutter')), 'atlas cell touching the border is reported and repaired');
  assert(at[3] === 0 && at[((W / 2) * W + W / 4) * 4 + 3] === 255, 'gutter is transparent after repair, content kept');
  assert(r.cells.length === 2 && r.cells[0][0] > 0 && r.cells[0][2] < 0.5, 'UV rects have a half-texel inset');
  // alpha bleed: transparent texels next to red take the red colour (no black halo in mips)
  const bl = new Float32Array(8 * 8 * 4);
  for (let x = 0; x < 4; x++) for (let y = 0; y < 8; y++) bl.set([255, 0, 0, 255], (y * 8 + x) * 4);
  cleanAndBleed(bl, 8, 8);
  assert(bl[(0 * 8 + 6) * 4] > 200 && bl[(0 * 8 + 6) * 4 + 3] === 0, 'colour bled into transparent texels, alpha kept 0');
  console.log('selftest passed');
}

// ------------------------------------------------------------------ main
if (flag('--selftest')) { await selftest(); process.exit(0); }
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
fs.mkdirSync(OUT, { recursive: true });
const cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : {};
const only = opt('--only');
const rows = [];
console.log(`Processing textures from ${path.relative(process.cwd(), ASSETS)} (KTX2 via Basis Universal + WebP fallback)`);
for (const [id, t] of Object.entries(manifest.textures)) {
  if (only && !id.includes(only)) continue;
  const { processed: _p, source: _s, ...def } = t;
  const src = path.join(ASSETS, t.file);
  const key = crypto.createHash('sha1').update(String(PIPELINE_VERSION)).update(JSON.stringify(def)).update(JSON.stringify(manifest.groups?.[t.group] ?? null))
    .update(fs.existsSync(src) ? fs.readFileSync(src) : Buffer.alloc(0)).digest('hex');
  const hit = cache[id];
  const outputsExist = hit?.result?.processed && Object.values(hit.result.processed.sizes).every(s => fs.existsSync(path.join(ASSETS, s.color)));
  let r;
  if (!flag('--force') && hit?.key === key && (outputsExist || !hit.result.processed)) { r = hit.result; r.cached = true; }
  else {
    const t0 = Date.now();
    r = await processEntry(id, t, manifest.groups ?? {});
    r.seconds = (Date.now() - t0) / 1000;
    cache[id] = { key, result: r };
  }
  if (r.processed) t.processed = r.processed; else delete t.processed;
  // the game loads the original image when processed files are missing (pipeline not run, failed entry)
  t.source = r.status !== 'missing';
  const disk = r.processed ? Object.values(r.processed.sizes).reduce((a, s) => a + s.diskBytes, 0) / 1048576 : 0;
  rows.push({ id, status: r.status + (r.cached ? ' (cached)' : ''), size: r.processed ? Object.keys(r.processed.sizes).sort((a, b) => b - a).join('/') : '-', seam: r.seam ? `${r.seam.before} -> ${r.seam.after}` : '-', mb: disk ? disk.toFixed(2) : '-', warnings: r.warnings });
  console.log(`  ${r.status.padEnd(7)} ${id}${r.cached ? ' (cached)' : r.seconds ? ` (${r.seconds.toFixed(0)} s)` : ''}`);
}
for (const [name, rel] of Object.entries(manifest.ui ?? {})) await processUi(name, rel);
fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));

// 11. summary
const pad = (s, n) => String(s).padEnd(n);
console.log(`\n${pad('texture', 26)} ${pad('status', 15)} ${pad('sizes', 14)} ${pad('seam before -> after', 21)} ${pad('disk MB', 8)} warnings`);
for (const r of rows) console.log(`${pad(r.id, 26)} ${pad(r.status, 15)} ${pad(r.size, 14)} ${pad(r.seam, 21)} ${pad(r.mb, 8)} ${r.warnings.join('; ')}`);
const mem = memoryPerPreset(manifest);
console.log('\nEstimated GPU texture memory (all textures resident; the game streams them by area):');
for (const [q, m] of Object.entries(mem)) console.log(`  ${pad(q, 7)} KTX2 ${m.ktx2MB.toFixed(1).padStart(6)} MB   WebP fallback ${m.webpMB.toFixed(1).padStart(6)} MB   budget ${m.budgetMB} MB${m.webpMB > m.budgetMB ? '  (fallback over budget: smaller sizes are used)' : ''}`);
console.log(`\nManifest updated: ${path.relative(process.cwd(), MANIFEST)}`);
