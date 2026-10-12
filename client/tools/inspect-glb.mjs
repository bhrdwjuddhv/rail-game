// Inspect a GLB: bounds (m), axes, nodes/meshes/materials, triangles, textures, named parts. Usage: node tools/inspect-glb.mjs <file> [maxNodes]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';
import fs from 'node:fs';
const [file, maxN = '60'] = process.argv.slice(2);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(file);
const r = doc.getRoot(), sc = r.listScenes()[0];
const b = getBounds(sc);
const size = b.max.map((v, i) => v - b.min[i]);
let tris = 0;
const meshTris = new Map();
for (const m of r.listMeshes()) { let t = 0; for (const p of m.listPrimitives()) { const idx = p.getIndices(); const n = idx ? idx.getCount() : p.getAttribute('POSITION').getCount(); t += p.getMode() === 5 ? n - 2 : n / 3; } meshTris.set(m, t); tris += t; }
console.log(`${file}: ${(fs.statSync(file).size / 1e6).toFixed(1)} MB`);
console.log(`bounds min ${b.min.map(v => v.toFixed(2))} max ${b.max.map(v => v.toFixed(2))} size ${size.map(v => v.toFixed(2))}`);
console.log(`nodes ${r.listNodes().length}, meshes ${r.listMeshes().length}, materials ${r.listMaterials().length}, textures ${r.listTextures().length}, triangles ${Math.round(tris)}, skins ${r.listSkins().length}, animations ${r.listAnimations().length}`);
const texs = r.listTextures().map(t => { const s = t.getSize(); return `${s?.[0]}x${s?.[1]}`; });
console.log('textures', [...new Set(texs)].map(s => `${s} x${texs.filter(x => x === s).length}`).join(', '));
console.log('materials', r.listMaterials().map(m => m.getName()).join(', ').slice(0, 1500));
// node tree with world bounds of each mesh node
const lines = [];
const walk = (n, d) => {
  const m = n.getMesh();
  let info = '';
  if (m) { const nb = getBounds(n); info = ` [mesh ${Math.round(meshTris.get(m))} tris, x ${nb.min[0].toFixed(1)}..${nb.max[0].toFixed(1)} y ${nb.min[1].toFixed(1)}..${nb.max[1].toFixed(1)} z ${nb.min[2].toFixed(1)}..${nb.max[2].toFixed(1)}]`; }
  lines.push(`${'  '.repeat(d)}${n.getName() || '(unnamed)'}${info}`);
  for (const c of n.listChildren()) walk(c, d + 1);
};
for (const n of sc.listChildren()) walk(n, 0);
console.log(lines.slice(0, Number(maxN)).join('\n'));
if (lines.length > Number(maxN)) console.log(`... ${lines.length - Number(maxN)} more nodes`);
