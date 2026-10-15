// Every mesh part of a GLB with its bounds (scene units x k, from the low end), sorted along the long axis: for fitting a new model.
// Usage: node tools/model-parts.mjs <file.glb> [k] [name filter]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const [f, kArg, filter] = process.argv.slice(2);
const doc = await io.read(f), root = doc.getRoot();
const sb = getBounds(root.listScenes()[0]);
const size = sb.max.map((v, i) => v - sb.min[i]);
const ax = size.indexOf(Math.max(...size));
const k = Number(kArg) || 1;
console.log('scene size', size.map(v => (v * k).toFixed(3)).join(' x '), 'long axis', ax, 'min', sb.min.map(v => (v * k).toFixed(3)).join(','));
const rows = [];
for (const n of root.listNodes()) {
  const m = n.getMesh(); if (!m) continue;
  if (filter && !new RegExp(filter, 'i').test(n.getName())) continue;
  const b = getBounds(n);
  let tris = 0; for (const p of m.listPrimitives()) { const i = p.getIndices(); tris += (i ? i.getCount() : p.getAttribute('POSITION').getCount()) / 3; }
  rows.push({ n: n.getName(), b, tris: Math.round(tris), mats: m.listPrimitives().map(p => p.getMaterial()?.getName()).join('/') });
}
rows.sort((a, b) => a.b.min[ax] - b.b.min[ax]);
const r = (b, i) => `${((b.min[i] - sb.min[i]) * k).toFixed(2)}..${((b.max[i] - sb.min[i]) * k).toFixed(2)}`;
for (const x of rows) console.log(`${x.n.padEnd(34)} long ${r(x.b, ax).padEnd(14)} up ${r(x.b, 1).padEnd(12)} side ${r(x.b, ax === 0 ? 2 : 0).padEnd(12)} tris ${String(x.tris).padStart(7)} ${x.mats}`);
