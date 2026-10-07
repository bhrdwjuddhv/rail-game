import * as THREE from 'three/webgpu';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const _c = new THREE.Color();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

/** Compose a matrix from position, Euler rotation (YXZ) and scale. */
export function mat(x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _e.set(rx, ry, rz, 'YXZ');
  return new THREE.Matrix4().compose(_p.set(x, y, z), _q.setFromEuler(_e), _s.set(sx, sy, sz));
}

/**
 * Collects many small primitives (with a colour each) and merges them into one
 * mesh per material key. This is how every static model (stations, bridges,
 * the loco body, props) stays at a handful of draw calls.
 */
export class GeoBatch {
  private parts = new Map<string, THREE.BufferGeometry[]>();

  add(geo: THREE.BufferGeometry, matrix: THREE.Matrix4 | null, color: THREE.ColorRepresentation, key = 'std') {
    // keep everything indexed: shared vertices let the GPU's post-transform cache work
    // (non-indexed boxes/blobs cost 1.5-6x the vertex shader invocations)
    let g = geo.clone();
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(name)) g.deleteAttribute(name);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    if (!g.index) g = mergeVertices(g);
    if (matrix) g.applyMatrix4(matrix);
    _c.set(color);
    const n = g.attributes.position.count;
    // a part that already has colours (a template built with GeoBatch) keeps them, tinted by \`color\`
    const own = g.attributes.color as THREE.BufferAttribute | undefined;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col[i * 3] = _c.r * (own ? own.getX(i) : 1); col[i * 3 + 1] = _c.g * (own ? own.getY(i) : 1); col[i * 3 + 2] = _c.b * (own ? own.getZ(i) : 1);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    let list = this.parts.get(key);
    if (!list) this.parts.set(key, (list = []));
    list.push(g);
    return this;
  }

  /** Box with UVs in metres (1 UV unit = 1 m on every face), so textures keep their real size. */
  box(w: number, h: number, d: number, m: THREE.Matrix4 | null, color: THREE.ColorRepresentation, key = 'std') {
    const g = new THREE.BoxGeometry(w, h, d);
    const uv = g.attributes.uv as THREE.BufferAttribute;
    // BoxGeometry face order: +x, -x, +y, -y, +z, -z; 4 vertices each
    const dims: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
    for (let f = 0; f < 6; f++) for (let k = 0; k < 4; k++) { const i = f * 4 + k; uv.setXY(i, uv.getX(i) * dims[f][0], uv.getY(i) * dims[f][1]); }
    return this.add(g, m, color, key);
  }
  /** Cylinder with UVs in metres (around the circumference x height). */
  cyl(rt: number, rb: number, h: number, seg: number, m: THREE.Matrix4 | null, color: THREE.ColorRepresentation, key = 'std') {
    const g = new THREE.CylinderGeometry(rt, rb, h, seg);
    const uv = g.attributes.uv as THREE.BufferAttribute;
    const circ = Math.PI * (rt + rb);
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * circ, uv.getY(i) * h);
    return this.add(g, m, color, key);
  }

  isEmpty() { return this.parts.size === 0; }

  /** Merged geometry for one key (used for instancing templates). */
  geometry(key = 'std') {
    const list = this.parts.get(key);
    return list && list.length ? mergeGeometries(list, false)! : null;
  }

  build(materials: Record<string, THREE.Material>, shadows = true): THREE.Group {
    const g = new THREE.Group();
    for (const [key, list] of this.parts) {
      const geo = mergeGeometries(list, false);
      if (!geo) continue;
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, materials[key] ?? materials.std);
      mesh.castShadow = shadows && key !== 'lamp' && key !== 'glass';
      mesh.receiveShadow = shadows;
      mesh.name = key;
      g.add(mesh);
    }
    this.parts.clear();
    return g;
  }
}

export { _m as tmpMatrix };
