// Texture pipeline: `npm run textures`
// For every entry in data/textures.json whose source image exists in public/assets/:
//   - resize to power-of-two (2048 and a half-size 1024 set for lower quality presets)
//   - tileable textures: make seamless with an offset-and-blend pass
//   - derive a normal map (height = luminance, Sobel) and a roughness map
//   - export WebP (+ KTX2/UASTC when `toktx` is installed) to public/assets/textures/_processed/
//   - update the manifest's "processed" field
// UI images (main menu, loading, logo) are converted to WebP next to their PNG.
// Options (for testing): --manifest <file> --assets <dir>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';

const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const MANIFEST = path.resolve(arg('--manifest', path.join(ROOT, 'data/textures.json')));
const ASSETS = path.resolve(arg('--assets', path.join(ROOT, 'public/assets')));
const OUT_REL = 'textures/_processed';
const OUT = path.join(ASSETS, OUT_REL);

const pot = v => 2 ** Math.round(Math.log2(Math.max(64, v)));
const hasTool = name => { try { execFileSync(name, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } };
const toktx = hasTool('toktx');

/** Offset-and-blend seamless: blend the image with a copy rolled by half its size, using a mask that is 1
 *  at the image border (where the original would show a seam on wrap) and 0 along the rolled copy's seams. */
function makeSeamless(px, w, h) {
  const out = Buffer.alloc(px.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dEdge = Math.min(x, w - 1 - x, y, h - 1 - y);
    const dSeam = Math.min(Math.abs(x - w / 2), Math.abs(y - h / 2));
    let m = dSeam / (dSeam + dEdge + 1e-6);
    m = m * m * (3 - 2 * m);
    const rx = (x + (w >> 1)) % w, ry = (y + (h >> 1)) % h;
    const i = (y * w + x) * 4, j = (ry * w + rx) * 4;
    for (let c = 0; c < 4; c++) out[i + c] = Math.round(px[i + c] * (1 - m) + px[j + c] * m);
  }
  return out;
}

/** Height from luminance (lightly blurred), Sobel gradient -> tangent-space normal (OpenGL / +Y up). */
function normalAndRoughness(px, w, h, wrap, strength = 2.2) {
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = (0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]) / 255;
  // 3x3 box blur to reduce noise
  const hgt = new Float32Array(w * h);
  const at = (a, x, y) => {
    if (wrap) { x = (x + w) % w; y = (y + h) % h; } else { x = Math.min(w - 1, Math.max(0, x)); y = Math.min(h - 1, Math.max(0, y)); }
    return a[y * w + x];
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s += at(lum, x + i, y + j);
    hgt[y * w + x] = s / 9;
  }
  let mean = 0;
  for (const v of hgt) mean += v;
  mean /= hgt.length;
  const nrm = Buffer.alloc(w * h * 4), rough = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const gx = (at(hgt, x + 1, y - 1) + 2 * at(hgt, x + 1, y) + at(hgt, x + 1, y + 1)) - (at(hgt, x - 1, y - 1) + 2 * at(hgt, x - 1, y) + at(hgt, x - 1, y + 1));
    const gy = (at(hgt, x - 1, y + 1) + 2 * at(hgt, x, y + 1) + at(hgt, x + 1, y + 1)) - (at(hgt, x - 1, y - 1) + 2 * at(hgt, x, y - 1) + at(hgt, x + 1, y - 1));
    let nx = -gx * strength, ny = gy * strength, nz = 1;
    const L = Math.hypot(nx, ny, nz); nx /= L; ny /= L; nz /= L;
    const i = (y * w + x) * 4;
    nrm[i] = Math.round((nx * 0.5 + 0.5) * 255); nrm[i + 1] = Math.round((ny * 0.5 + 0.5) * 255); nrm[i + 2] = Math.round((nz * 0.5 + 0.5) * 255); nrm[i + 3] = 255;
    // crevices (darker than average) are rougher, highlights a little smoother
    const r = Math.min(1, Math.max(0.3, 0.78 + (mean - hgt[y * w + x]) * 0.9));
    rough[i] = rough[i + 1] = rough[i + 2] = Math.round(r * 255); rough[i + 3] = 255;
  }
  return { nrm, rough };
}

async function writeWebp(buf, w, h, file, quality, lossless = false) {
  await sharp(buf, { raw: { width: w, height: h, channels: 4 } }).webp({ quality, lossless, alphaQuality: 100, effort: 5 }).toFile(file);
}

async function processTexture(id, t) {
  const src = path.join(ASSETS, t.file);
  if (!fs.existsSync(src)) { console.log(`  - ${id}: ${t.file} not found (procedural texture stays in use)`); return null; }
  const meta = await sharp(src).metadata();
  const full = t.tileable ? pot(Math.min(meta.width, meta.height, 2048)) : null;
  const W = full ?? Math.min(2048, pot(meta.width)), H = full ?? Math.min(2048, pot(meta.height));
  const base = id.replace(/\//g, '_');
  const result = {};
  for (const [label, w, h] of [['full', W, H], ['half', Math.max(64, W >> 1), Math.max(64, H >> 1)]]) {
    let { data } = await sharp(src).ensureAlpha().resize(w, h, { fit: t.tileable ? 'cover' : 'fill', kernel: 'lanczos3' }).raw().toBuffer({ resolveWithObject: true });
    if (t.tileable) data = makeSeamless(data, w, h);
    const names = { color: `${base}_${w}_color.webp` };
    await writeWebp(data, w, h, path.join(OUT, names.color), 88);
    if (t.normal) {
      const { nrm, rough } = normalAndRoughness(data, w, h, t.tileable);
      names.normal = `${base}_${w}_normal.webp`;
      names.roughness = `${base}_${w}_rough.webp`;
      await writeWebp(nrm, w, h, path.join(OUT, names.normal), 92);
      await writeWebp(rough, w, h, path.join(OUT, names.roughness), 85);
    }
    if (toktx && label === 'full') {
      const png = path.join(OUT, `${base}_${w}_color.tmp.png`);
      await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toFile(png);
      try {
        execFileSync('toktx', ['--t2', '--encode', 'uastc', '--genmipmap', '--assign_oetf', 'srgb', path.join(OUT, `${base}_${w}_color.ktx2`), png], { stdio: 'ignore' });
        names.ktx2 = `${base}_${w}_color.ktx2`;
      } catch (e) { console.log(`  ! ${id}: toktx failed (${e.message})`); }
      fs.rmSync(png, { force: true });
    }
    result[label] = { size: [w, h], ...Object.fromEntries(Object.entries(names).map(([k, v]) => [k, `${OUT_REL}/${v}`])) };
  }
  console.log(`  + ${id}: ${W}x${H}${t.tileable ? ' seamless' : ''}${t.normal ? ' +normal +roughness' : ''}`);
  return result;
}

async function processUi(name, rel) {
  const pngs = ['.png', '.jpg', '.jpeg'].map(e => path.join(ASSETS, rel + e)).filter(f => fs.existsSync(f));
  if (!pngs.length) { console.log(`  - ui ${name}: ${rel}.png not found (CSS fallback in use)`); return; }
  const out = path.join(ASSETS, rel + '.webp');
  await sharp(pngs[0]).resize({ width: 1920, withoutEnlargement: true }).webp({ quality: 82, effort: 5 }).toFile(out);
  const kb = (f) => (fs.statSync(f).size / 1024).toFixed(0);
  console.log(`  + ui ${name}: ${path.basename(pngs[0])} (${kb(pngs[0])} KB) -> ${path.basename(out)} (${kb(out)} KB)`);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
fs.mkdirSync(OUT, { recursive: true });
console.log(`Processing textures from ${ASSETS}`);
if (!toktx) console.log('  (KTX2 skipped: toktx not found on PATH - install KTX-Software to also produce .ktx2)');
for (const [id, t] of Object.entries(manifest.textures)) {
  const r = await processTexture(id, t);
  if (r) t.processed = r; else delete t.processed;
}
for (const [name, rel] of Object.entries(manifest.ui ?? {})) await processUi(name, rel);
fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Manifest updated: ${path.relative(ROOT, MANIFEST)}`);
