import * as THREE from 'three/webgpu';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const _c = new THREE.Color();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

/** Compose a matrix from position, Euler rotation (YXZ) and scale. */
/**
 * A hipped roof: a four-sided pyramid with its base w (x) by d (z), h high, centred on the origin (base at -h/2).
 * Turned before it is scaled, so its edges stay square to the building whatever its proportions (a pyramid
 * scaled and then turned 45 degrees comes out as a skewed diamond).
 */
export function hipRoof(w: number, h: number, d: number) {
  const g = new THREE.CylinderGeometry(0, Math.SQRT1_2, 1, 4, 1);
  g.rotateY(Math.PI / 4);
  return g.scale(w, h, d);
}

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

/** a shape ready to be copied: indexed, with normals, UVs and (its own) colours */
interface Proto { pos: ArrayLike<number>; nor: ArrayLike<number>; uv: ArrayLike<number> | null; col: ArrayLike<number> | null; idx: ArrayLike<number> }
const protos = new WeakMap<THREE.BufferGeometry, Proto>();
const unitShapes = new Map<string, THREE.BufferGeometry>();
const _n3 = new THREE.Matrix3();
const _v = new THREE.Vector3();

/**
 * GeoBatch's quick sibling, for thousands of small copies of a few shapes (a hedge's tufts, a road's studs, its
 * trees): each shape is made indexed once and every copy only transformed and appended - no clone, no vertex
 * merge per copy (GeoBatch's cost: a km of highway took 400 ms). Same add / box / cyl / build; one mesh per key.
 */
export class FastBatch {
  private parts = new Map<string, { p: number[]; n: number[]; u: number[]; c: number[]; i: number[] }>();

  private proto(geo: THREE.BufferGeometry): Proto {
    let p = protos.get(geo);
    if (p) return p;
    let g = geo;
    if (!g.index) g = mergeVertices(g.clone());
    if (!g.attributes.normal) g.computeVertexNormals();
    p = { pos: g.attributes.position.array, nor: g.attributes.normal.array, uv: g.attributes.uv?.array ?? null, col: g.attributes.color?.array ?? null, idx: g.index!.array };
    protos.set(geo, p);
    return p;
  }

  add(geo: THREE.BufferGeometry, matrix: THREE.Matrix4 | null, color: THREE.ColorRepresentation, key = 'std') {
    const pr = this.proto(geo);
    let part = this.parts.get(key);
    if (!part) this.parts.set(key, (part = { p: [], n: [], u: [], c: [], i: [] }));
    const base = part.p.length / 3, nv = pr.pos.length / 3;
    _c.set(color);
    if (matrix) _n3.getNormalMatrix(matrix);
    for (let v = 0; v < nv; v++) {
      _v.set(pr.pos[v * 3], pr.pos[v * 3 + 1], pr.pos[v * 3 + 2]);
      if (matrix) _v.applyMatrix4(matrix);
      part.p.push(_v.x, _v.y, _v.z);
      _v.set(pr.nor[v * 3], pr.nor[v * 3 + 1], pr.nor[v * 3 + 2]);
      if (matrix) _v.applyMatrix3(_n3).normalize();
      part.n.push(_v.x, _v.y, _v.z);
      part.u.push(pr.uv ? pr.uv[v * 2] : 0, pr.uv ? pr.uv[v * 2 + 1] : 0);
      part.c.push(_c.r * (pr.col ? pr.col[v * 3] : 1), _c.g * (pr.col ? pr.col[v * 3 + 1] : 1), _c.b * (pr.col ? pr.col[v * 3 + 2] : 1));
    }
    for (let k = 0; k < pr.idx.length; k++) part.i.push(base + pr.idx[k]);
    return this;
  }

  private unit(key: string, make: () => THREE.BufferGeometry) {
    let g = unitShapes.get(key);
    if (!g) unitShapes.set(key, (g = make()));
    return g;
  }

  box(w: number, h: number, d: number, m: THREE.Matrix4 | null, color: THREE.ColorRepresentation, key = 'std') {
    const s = new THREE.Matrix4().makeScale(w, h, d);
    return this.add(this.unit('box', () => new THREE.BoxGeometry(1, 1, 1)), m ? m.clone().multiply(s) : s, color, key);
  }

  /** a cylinder (its taper kept to the nearest 5 %) */
  cyl(rt: number, rb: number, h: number, seg: number, m: THREE.Matrix4 | null, color: THREE.ColorRepresentation, key = 'std') {
    const k = rb > 0 ? Math.round((rt / rb) * 20) / 20 : 1, r = rb > 0 ? rb : rt;
    const s = new THREE.Matrix4().makeScale(r, h, r);
    return this.add(this.unit(`cyl:${k}:${seg}`, () => new THREE.CylinderGeometry(k, 1, 1, seg)), m ? m.clone().multiply(s) : s, color, key);
  }

  isEmpty() { return this.parts.size === 0; }

  geometry(key = 'std') {
    const part = this.parts.get(key);
    if (!part || !part.i.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(part.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(part.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(part.u, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(part.c, 3));
    g.setIndex(part.p.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(part.i, 1) : new THREE.Uint16BufferAttribute(part.i, 1));
    return g;
  }

  build(materials: Record<string, THREE.Material>, shadows = true): THREE.Group {
    const out = new THREE.Group();
    for (const key of this.parts.keys()) {
      const geo = this.geometry(key);
      if (!geo) continue;
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, materials[key] ?? materials.std);
      mesh.castShadow = shadows && key !== 'lamp' && key !== 'glass';
      mesh.receiveShadow = shadows;
      mesh.name = key;
      out.add(mesh);
    }
    this.parts.clear();
    return out;
  }
}
