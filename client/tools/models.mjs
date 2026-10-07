// Optimise 3D models for the game (npm run models).
//
// For every data/locomotives/*.json with a "model" section, reads its source
// GLB (never modified) and writes optimised copies to
// client/public/assets/models/_processed/<id>.<variant>.glb:
//   high    full geometry, textures capped at 2048   (desktop High / Ultra, near)
//   medium  full geometry, textures capped at 1024   (Medium, near)
//   lod1    parts under 0.35 m and the cab interior dropped, simplified, textures 512   (Low / mobile near; mid-distance)
//   lod2    only parts over 1.6 m (body, bogie frames), simplified, textures 256          (far)
// Each: texturePatches from the data repainted (fictional operator name), duplicate
// data merged, unused data pruned, vertices welded, LOD simplification (meshoptimizer),
// textures resized + KTX2 (Basis ETC1S, WASM encoder, mipmaps), geometry Meshopt-compressed.
// Node names are kept: the game finds bogies, wheels and pantograph arms by name.
// Results are cached by content hash in _processed/cache.json.
//
// Usage: node tools/models.mjs [--force] [--only <id>]
// The first run encodes every texture (a couple of minutes per model); encoded textures are
// cached in _processed/.ktx2-cache, so later runs only redo what changed. To test a new model
// before running this at all, just start the game: it falls back to the source GLB (slower to
// load, original livery text) when the optimised files are missing.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { encodeToKTX2 } from 'ktx2-encoder';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRTextureBasisu } from '@gltf-transform/extensions';
import { convertPrimitiveToTriangles, dedup, getBounds, meshopt, prune, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

const PIPELINE_VERSION = 6;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.resolve(ROOT, '..', 'data', 'locomotives');
const OUT = path.join(PUBLIC, 'assets', 'models', '_processed');
const CACHE = path.join(OUT, 'cache.json');
const TEX_CACHE = path.join(OUT, '.ktx2-cache');
const VARIANTS = [
  { name: 'high', ratio: 1, tex: 2048 },
  { name: 'medium', ratio: 1, tex: 1024 },
  { name: 'lod1', ratio: 0.35, error: 0.05, tex: 512, minPartM: 0.35, dropCab: true },
  { name: 'lod2', ratio: 0.12, error: 0.25, tex: 256, minPartM: 1.6, dropCab: true },
];

const args = process.argv.slice(2);
const flag = f => args.includes(f);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready, MeshoptSimplifier.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });

/** Triangles drawn (per unique mesh): lists count / 3, strips and fans count - 2. */
function triangles(doc) {
  let t = 0;
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) {
    const i = p.getIndices();
    const n = i ? i.getCount() : p.getAttribute('POSITION').getCount();
    t += p.getMode() === 4 ? n / 3 : p.getMode() === 5 || p.getMode() === 6 ? Math.max(0, n - 2) : 0;
  }
  return Math.round(t);
}

const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Repaint rectangles of a texture with our own text (operator name). */
async function patchTexture(tex, patches) {
  const img = sharp(Buffer.from(tex.getImage()));
  const { width, height } = await img.metadata();
  const layers = patches.map(p => {
    const [x, y, w, h] = p.rect;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${p.fill}"/>` +
      `<text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" font-family="Nirmala UI, Noto Sans Devanagari, Mangal, Noto Sans, Arial, sans-serif" font-size="${p.size}" fill="${p.color}">${esc(p.text)}</text></svg>`;
    return { input: Buffer.from(svg), left: x, top: y };
  });
  const out = await img.composite(layers).png().toBuffer();
  tex.setImage(new Uint8Array(out)).setMimeType('image/png');
  return { width, height };
}

/** Resize every texture to the cap and encode it to KTX2 (Basis ETC1S colour; UASTC for normal maps). */
async function compressTextures(doc, cap) {
  const root = doc.getRoot();
  const normals = new Set(root.listMaterials().map(m => m.getNormalTexture()).filter(Boolean));
  const colors = new Set([...root.listMaterials().map(m => m.getBaseColorTexture()), ...root.listMaterials().map(m => m.getEmissiveTexture())].filter(Boolean));
  let bytes = 0;
  for (const tex of root.listTextures()) {
    const src = sharp(Buffer.from(tex.getImage()));
    const meta = await src.metadata();
    const size = Math.min(cap, Math.max(meta.width, meta.height));
    const pow = 2 ** Math.round(Math.log2(size)); // power of two (mipmaps, compressed formats)
    const { data, info } = await src.resize(pow, pow, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const normal = normals.has(tex), color = colors.has(tex) && !normal;
    // encoded textures are cached on disk by content + size: re-runs (and variants sharing a size) skip the encoder
    const key = crypto.createHash('sha1').update(String(PIPELINE_VERSION)).update(data).update(`${info.width}|${normal}|${color}`).digest('hex');
    const cached = path.join(TEX_CACHE, `${key}.ktx2`);
    let ktx;
    if (fs.existsSync(cached)) ktx = fs.readFileSync(cached);
    else {
      const raw = new Uint8Array(data);
      ktx = await encodeToKTX2(raw, {
        isKTX2File: true, generateMipmap: true, isYFlip: false, // glTF images are not flipped
        isUASTC: normal, isNormalMap: normal, needSupercompression: normal,
        qualityLevel: normal ? 128 : 150, compressionLevel: info.width > 512 ? 2 : 1,
        isPerceptual: color, isSetKTX2SRGBTransferFunc: color,
        imageDecoder: async () => ({ data: raw, width: info.width, height: info.height }),
      });
      fs.writeFileSync(cached, ktx);
    }
    tex.setImage(new Uint8Array(ktx)).setMimeType('image/ktx2');
    bytes += info.width * info.height * (normal ? 1 : 0.5) * 1.333; // GPU bytes (BC7/ETC2-class ~1 B/px, BC1/ETC1 ~0.5)
  }
  doc.createExtension(KHRTextureBasisu).setRequired(true);
  return bytes;
}

/** Detach meshes smaller than minM metres (bounding diagonal after the model scale) or under a named node in `drop`. */
function dropSmallParts(doc, minM, scale, drop) {
  const named = n => { for (let p = n; p; p = p.getParentNode()) if (drop.has(p.getName())) return true; return false; };
  for (const n of doc.getRoot().listNodes()) {
    if (!n.getMesh()) continue;
    const b = getBounds(n);
    const diag = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) * scale;
    if (diag < minM || named(n)) n.setMesh(null);
  }
}

/**
 * Reduce every triangle-list primitive to about `ratio` of its triangles with
 * meshoptimizer's sloppy simplifier (error: fraction of the part's size).
 * Unused vertices are dropped later by the Meshopt reorder.
 */
function sloppy(doc, ratio, error) {
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) {
    const idx = p.getIndices(), pos = p.getAttribute('POSITION');
    if (!idx || p.getMode() !== 4 || idx.getCount() < 180) continue;
    const indices = Uint32Array.from(idx.getArray());
    const positions = pos.getArray() instanceof Float32Array ? pos.getArray() : Float32Array.from(pos.getArray());
    const target = Math.max(36, Math.floor((indices.length * ratio) / 3) * 3);
    const [out] = MeshoptSimplifier.simplifySloppy(indices, positions, 3, null, Math.min(target, indices.length), error);
    if (out.length >= 3) idx.setArray(pos.getCount() > 65535 ? out : Uint16Array.from(out));
  }
}

/** Drop the parts the data leaves out: outside cfg.keep (one section of a twin loco), and pantograph arms the game replaces. */
function keepParts(doc, cfg) {
  const remove = new Set([...(cfg.proceduralPantographs?.remove ?? []), ...(cfg.remove ?? [])]);
  // glass: tagged before materials are merged (the merge may keep another material's name)
  const glass = new Set(cfg.glassMaterials ?? []);
  for (const m of doc.getRoot().listMaterials()) if (glass.has(m.getName())) m.setExtras({ ...m.getExtras(), rbGlass: true });
  for (const n of doc.getRoot().listNodes()) {
    if (!n.getMesh()) continue;
    let gone = false;
    for (let p = n; p; p = p.getParentNode()) if (remove.has(p.getName())) gone = true;
    if (!gone && cfg.keep) {
      const b = getBounds(n), c = (b.min[cfg.keep.axis] + b.max[cfg.keep.axis]) / 2;
      gone = c < (cfg.keep.min ?? -Infinity) || c > (cfg.keep.max ?? Infinity);
    }
    if (gone) n.setMesh(null);
  }
}

async function processLoco(id, cfg, cache) {
  const src = path.join(PUBLIC, cfg.file);
  if (!fs.existsSync(src)) return { id, status: 'missing', note: `${cfg.file} not found` };
  const key = crypto.createHash('sha1').update(String(PIPELINE_VERSION)).update(JSON.stringify([cfg.texturePatches ?? null, cfg.keep ?? null, cfg.proceduralPantographs ?? null, cfg.hideInCab, cfg.remove ?? null, cfg.glassMaterials ?? null])).update(fs.readFileSync(src)).digest('hex');
  const outputs = VARIANTS.map(v => path.join(OUT, `${id}.${v.name}.glb`));
  if (!flag('--force') && cache[id]?.key === key && outputs.every(f => fs.existsSync(f))) return { ...cache[id].result, cached: true };

  const before = await io.read(src);
  const result = { id, status: 'ok', source: { mb: +(fs.statSync(src).size / 1048576).toFixed(2), triangles: triangles(before), meshes: before.getRoot().listMeshes().length, materials: before.getRoot().listMaterials().length, textures: before.getRoot().listTextures().map(t => (t.getSize() ?? []).join('x')) }, variants: {} };
  const b = getBounds(before.getRoot().listScenes()[0]);
  result.source.size = b.max.map((v, i) => +(v - b.min[i]).toFixed(3));
  for (const v of VARIANTS) {
    const doc = await io.read(src);
    for (const p of cfg.texturePatches ?? []) {
      const tex = doc.getRoot().listTextures()[p.texture];
      if (tex) await patchTexture(tex, [p]);
    }
    keepParts(doc, cfg);
    await doc.transform(dedup(), prune({ keepLeaves: true }), weld());
    // every variant ends as plain triangle lists: the source is triangle strips, which the
    // loader would otherwise convert on the main thread
    for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) if (p.getMode() === 5 || p.getMode() === 6) convertPrimitiveToTriangles(p);
    if (v.ratio < 1) {
      // far LODs: drop small parts (bolts, brake gear, the cab interior), then reduce each
      // part's triangles. The model is flat-shaded (no shared vertices across faces), so the
      // seam-preserving simplifier cannot collapse anything; sloppy simplification works on
      // positions only, which is right at the distances these LODs are shown
      dropSmallParts(doc, v.minPartM, cfg.scale, v.dropCab ? new Set(cfg.hideInCab) : new Set());
      sloppy(doc, v.ratio, v.error);
    }
    const gpu = await compressTextures(doc, v.tex);
    await doc.transform(prune({ keepLeaves: true }), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
    const file = outputs[VARIANTS.indexOf(v)];
    await io.write(file, doc);
    result.variants[v.name] = { mb: +(fs.statSync(file).size / 1048576).toFixed(2), triangles: triangles(doc), textureGpuMB: +(gpu / 1048576).toFixed(1), materials: doc.getRoot().listMaterials().length };
  }
  cache[id] = { key, result };
  return result;
}

fs.mkdirSync(TEX_CACHE, { recursive: true });
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
const rows = [];
for (const f of fs.readdirSync(DATA).filter(f => f.endsWith('.json'))) {
  const loco = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
  if (!loco.model?.file || (only && loco.id !== only)) continue;
  const t0 = Date.now();
  process.stdout.write(`  ${loco.id} ... `);
  const r = await processLoco(loco.id, loco.model, cache);
  console.log(`${r.status}${r.cached ? ' (cached)' : ''} ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  rows.push(r);
}
fs.writeFileSync(CACHE, JSON.stringify(cache, null, 1));
for (const r of rows) {
  if (r.status !== 'ok') { console.log(`${r.id}: ${r.status} - ${r.note}`); continue; }
  console.log(`\n${r.id}: source ${r.source.mb} MB, ${r.source.triangles} triangles, ${r.source.meshes} meshes, ${r.source.materials} materials, ${r.source.textures.length} textures (${[...new Set(r.source.textures)].join(', ')}), size ${r.source.size.join(' x ')}`);
  console.log('  variant  file MB  triangles  texture GPU MB  materials');
  for (const [k, v] of Object.entries(r.variants)) console.log(`  ${k.padEnd(7)}  ${String(v.mb).padStart(7)}  ${String(v.triangles).padStart(9)}  ${String(v.textureGpuMB).padStart(14)}  ${String(v.materials).padStart(9)}`);
}
