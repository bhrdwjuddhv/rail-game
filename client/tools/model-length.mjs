// Each loco model fitted as its data says (rotation, scale, offset): length and overhang against its data length.
// Usage: node tools/model-length.mjs
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const rot = (v, [rx, ry, rz]) => { // XYZ euler, degrees (three.js order: R = Rx * Ry * Rz applied to v as Rz first? three 'XYZ' => matrix = Rx*Ry*Rz)
  const r = d => d * Math.PI / 180;
  let [x, y, z] = v;
  // apply Rz, then Ry, then Rx (matrix Rx*Ry*Rz times v)
  let c = Math.cos(r(rz)), s = Math.sin(r(rz)); [x, y] = [x * c - y * s, x * s + y * c];
  c = Math.cos(r(ry)); s = Math.sin(r(ry)); [x, z] = [x * c + z * s, -x * s + z * c];
  c = Math.cos(r(rx)); s = Math.sin(r(rx)); [y, z] = [y * c - z * s, y * s + z * c];
  return [x, y, z];
};
const dir = process.argv[2] ?? '../data/locomotives';
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
  const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const m = d.model;
  if (!m?.file) continue;
  const doc = await io.read(path.join('public', m.file));
  const drop = new Set([...(m.remove ?? []), ...(m.proceduralPantographs?.remove ?? [])]);
  let lo = Infinity, hi = -Infinity, ylo = Infinity;
  for (const n of doc.getRoot().listNodes()) {
    if (!n.getMesh()) continue;
    let gone = false; for (let p = n; p; p = p.getParentNode()) if (drop.has(p.getName())) gone = true;
    if (gone) continue;
    const b = getBounds(n);
    if (m.keep) { const c = (b.min[m.keep.axis] + b.max[m.keep.axis]) / 2; if (c < (m.keep.min ?? -Infinity) || c > (m.keep.max ?? Infinity)) continue; }
    for (const cx of [b.min[0], b.max[0]]) for (const cy of [b.min[1], b.max[1]]) for (const cz of [b.min[2], b.max[2]]) {
      const [x, y] = rot([cx, cy, cz], m.rotationDeg).map(v => v * m.scale);
      lo = Math.min(lo, x + m.offset[0]); hi = Math.max(hi, x + m.offset[0]); ylo = Math.min(ylo, y + m.offset[1]);
    }
  }
  const secs = d.trainset ? null : Math.max(1, Math.round(d.sections ?? 1));
  const L = d.trainset ? d.trainset.cars[0].lengthM : d.lengthM / secs;
  console.log(`${d.id.padEnd(14)} model x ${lo.toFixed(2)}..${hi.toFixed(2)} (${(hi - lo).toFixed(2)} m) data length ${L.toFixed(2)}${secs > 1 ? ` (1 of ${secs} sections)` : ''} -> overhang front ${(hi - L / 2).toFixed(2)} rear ${(-L / 2 - lo).toFixed(2)}, lowest y ${ylo.toFixed(2)}`);
}
