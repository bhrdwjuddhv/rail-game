import fs from 'node:fs';
import { Matrix4, Vector3, Quaternion, Box3 } from 'three';
const [f, re, sc, ox, oy, oz, rot] = process.argv.slice(2);
const b = fs.readFileSync(f), j = JSON.parse(b.slice(20, 20 + b.readUInt32LE(12)).toString());
const L = n => n.matrix ? new Matrix4().fromArray(n.matrix) : new Matrix4().compose(new Vector3(...(n.translation ?? [0, 0, 0])), new Quaternion(...(n.rotation ?? [0, 0, 0, 1])), new Vector3(...(n.scale ?? [1, 1, 1])));
const fit = new Matrix4().compose(new Vector3(+ox, +oy, +oz), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), +rot * Math.PI / 180), new Vector3(+sc, +sc, +sc));
const g = new RegExp(re);
function walk(i, pm) {
  const n = j.nodes[i], m = pm.clone().multiply(L(n));
  if (g.test(n.name ?? '')) {
    if (n.mesh !== undefined) { const bb = new Box3(); for (const p of j.meshes[n.mesh].primitives) { const a = j.accessors[p.attributes.POSITION]; bb.union(new Box3(new Vector3(...a.min), new Vector3(...a.max)).applyMatrix4(m)); } console.log(n.name.padEnd(34), bb.min.toArray().map(v => v.toFixed(2)).join(','), ' .. ', bb.max.toArray().map(v => v.toFixed(2)).join(',')); }
    else { const p = new Vector3().setFromMatrixPosition(m); const fwd = new Vector3(0, 0, -1).transformDirection(m); console.log(n.name.padEnd(34), 'at', p.toArray().map(v => v.toFixed(2)).join(','), 'looks', fwd.toArray().map(v => v.toFixed(2)).join(',')); }
  }
  for (const c of n.children ?? []) walk(c, m);
}
for (const r of j.scenes[0].nodes) walk(r, fit);
