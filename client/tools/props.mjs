// Optimise station props (run by `npm run models`): every GLB in public/assets/station/ (source, never modified)
// to public/assets/models/_processed/station/<name>.glb: welded, simplified (meshoptimizer), textures resized to
// 512 px WebP, geometry Meshopt-compressed. Placed many times along the line (instanced), so kept light.
// The game falls back to the source file when the processed one is missing.
//
// Usage: node tools/props.mjs [--force]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, simplifyPrimitive, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'public', 'assets', 'station');
const OUT = path.join(ROOT, 'public', 'assets', 'models', '_processed', 'station');
const force = process.argv.includes('--force');

await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready, MeshoptSimplifier.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });

fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.existsSync(SRC) ? fs.readdirSync(SRC).filter(x => x.endsWith('.glb')) : []) {
  const src = path.join(SRC, f), out = path.join(OUT, f);
  if (!force && fs.existsSync(out) && fs.statSync(out).mtimeMs > fs.statSync(src).mtimeMs) { console.log(`station/${f}: up to date`); continue; }
  const doc = await io.read(src);
  await doc.transform(dedup(), weld());
  // only the dense parts simplified (the taps: 52k triangles); simple ones (the counter) kept as modelled
  // ponytail: one level of detail (a prop seen from the platform); add LODs if far stations ever cost too much
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) {
    if ((p.getIndices()?.getCount() ?? 0) / 3 > 5000) simplifyPrimitive(p, { simplifier: MeshoptSimplifier, ratio: 0.1, error: 0.004 });
  }
  await doc.transform(
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [512, 512] }),
    prune(), meshopt({ encoder: MeshoptEncoder }),
  );
  await io.write(out, doc);
  console.log(`station/${f}: ${(fs.statSync(src).size / 1e6).toFixed(1)} MB -> ${(fs.statSync(out).size / 1e6).toFixed(2)} MB`);
}
