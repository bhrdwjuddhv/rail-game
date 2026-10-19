import * as THREE from 'three/webgpu';
import { rng } from '@rail/shared/util';
import { GeoBatch, mat } from '../core/GeoBatch';
import { materials } from '../core/Materials';
import type { StationInfo } from '@rail/shared/track/Route';
import type { Cargo } from '@rail/shared/track/StationProfile';
import TEXTURES from '../../../data/textures.json';
import { textures } from '../core/TextureLibrary';
import { canvasTexture, uvToRect } from '../core/Textures';

/**
 * The cargo atlas (data/textures.json buildings/goods-cargo: sacks of grain, cement bags, cartons, logs, coils,
 * marble...): each cargo's cell, the solid block of it (cellInfo.body); none until it is processed.
 */
const CARGO_CELL: Record<Cargo, number> = { grain: 0, sugar: 1, cement: 2, fertiliser: 3, cartons: 4, timber: 6, steel: 7, salt: 12, stone: 13, marble: 13, fish: 14, tea: 14 };
const cargoInfo = (TEXTURES.textures as unknown as Record<string, { processed?: { cellInfo?: { body: number[] }[] } }>)['buildings/goods-cargo']?.processed?.cellInfo;
let cargoMat: THREE.MeshStandardMaterial | null = null;
function cargoMaterial() {
  if (cargoMat) return cargoMat;
  cargoMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
  textures.bind(cargoMat, 'cargo', () => canvasTexture('plain-white', 4, 4, (g, w, h) => { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); }, { repeat: false }), 1, { resident: true });
  return cargoMat;
}

type At = (km: number, lat: number) => { x: number; y: number; z: number; ry: number; h: number };

/** the loading platform's height above the rails' base level (a goods platform: wagon-floor high) */
const GOODS_PF_H = 1.05;
/** km either side of the station's middle the loading platform runs */
export const GOODS_HALF_KM = 0.15;

/**
 * A station's goods yard (StationProfile.goods): beside the goods line a raised loading platform with an open
 * goods shed and a goods office, stacks of what the region ships (sacks of grain, cement bags, marble blocks,
 * salt, fish crates, tea chests, timber, steel coils...), forklifts, sack trolleys, handcarts and a weighing
 * scale; behind it a truck yard with lorries and a tractor and trailer. The stacks are in three layers, shown
 * by how full the yard is (setFill: grows while wagons are unloaded, shrinks while they are loaded).
 */
export function goodsYard(b: GeoBatch, group: THREE.Group, at: At, st: StationInfo, lineOffset: number, cargo: Cargo[], spots: { x: number; y: number; z: number; heading: number }[]) {
  const s = Math.sign(lineOffset) || 1, p0 = lineOffset + s * 1.75, p1 = p0 + s * 9, mid = (p0 + p1) / 2;
  const r = rng(Math.round(st.km * 1000) + 977);
  const k0 = st.km - GOODS_HALF_KM, k1 = st.km + GOODS_HALF_KM;
  // the loading platform: a long raised deck, its face to the line edged in yellow
  for (let km = k0; km < k1 - 1e-6; km += 0.02) {
    const q = at(km + 0.01, mid);
    b.box(20.05, GOODS_PF_H + 0.4, 9, mat(q.x, q.y + (GOODS_PF_H - 0.4) / 2, q.z, q.ry), '#a39b8e', 'concrete');
    const e = at(km + 0.01, p0 + s * 0.15);
    b.box(20.05, 0.03, 0.3, mat(e.x, e.y + GOODS_PF_H + 0.02, e.z, e.ry), '#e2b31b');
  }
  // the goods shed: steel columns and a pitched tin roof over the middle, open sides
  const shedHalf = 0.035;
  for (let km = st.km - shedHalf; km <= st.km + shedHalf + 1e-6; km += 0.007) for (const dl of [-3.6, 3.6]) {
    const q = at(km, mid + dl);
    b.box(0.25, 5.2, 0.25, mat(q.x, q.y + GOODS_PF_H + 2.6, q.z, q.ry), '#6b7378', 'metal');
  }
  const sq = at(st.km, mid);
  for (const e of [-1, 1]) b.box(shedHalf * 2000 + 2, 0.1, 5.2, mat(sq.x, sq.y + GOODS_PF_H + 5.9, sq.z, sq.ry).multiply(mat(0, 0, e * 2.4, 0, e * 0.26)), '#8d9599', 'metal');
  // the goods office at the far end, and a platform scale with its dial post
  const oq = at(k1 - 0.012, mid);
  b.box(8, 3.2, 6, mat(oq.x, oq.y + GOODS_PF_H + 1.6, oq.z, oq.ry), '#efe2c6', 'wall');
  b.box(8.6, 0.3, 6.6, mat(oq.x, oq.y + GOODS_PF_H + 3.35, oq.z, oq.ry), '#7b2230');
  b.box(1, 2, 0.06, mat(oq.x, oq.y + GOODS_PF_H + 1, oq.z, oq.ry).multiply(mat(-4.03, 0, 0, Math.PI / 2)), '#5a3a22');
  const wq = at(st.km + shedHalf + 0.012, mid);
  b.box(2.4, 0.12, 2.4, mat(wq.x, wq.y + GOODS_PF_H + 0.06, wq.z, wq.ry), '#4d5257', 'metal');
  b.box(0.3, 1.4, 0.3, mat(wq.x, wq.y + GOODS_PF_H + 0.7, wq.z, wq.ry).multiply(mat(1.6, 0, 0)), '#c0392b');
  // forklifts, sack trolleys, handcarts on the platform
  for (let i = 0; i < 2; i++) {
    const q = at(st.km - 0.05 + i * 0.1, mid + s * (r() - 0.5) * 3), m = mat(q.x, q.y + GOODS_PF_H, q.z, q.ry + r() * 6.28);
    b.box(2.2, 1.1, 1.2, m.clone().multiply(mat(-0.4, 0.75, 0)), '#d68a1b', 'metal');
    b.box(0.8, 1.0, 1.0, m.clone().multiply(mat(-0.9, 1.75, 0)), '#2b2b2b', 'metal');
    b.box(0.12, 2.4, 1.0, m.clone().multiply(mat(0.85, 1.2, 0)), '#3a3a3a', 'metal');
  }
  for (let i = 0; i < 5; i++) {
    const q = at(k0 + 0.02 + r() * (k1 - k0 - 0.04), mid + (r() - 0.5) * 6), m = mat(q.x, q.y + GOODS_PF_H, q.z, q.ry + r() * 6.28);
    if (i % 2) { b.box(0.08, 1.3, 0.5, m.clone().multiply(mat(0, 0.65, 0, 0, 0, 0.25)), '#3a3a3a', 'metal'); b.cyl(0.15, 0.15, 0.6, 8, m.clone().multiply(mat(0.2, 0.15, 0, 0, Math.PI / 2)), '#1c1c1c'); }
    else { b.box(1.8, 0.1, 1.0, m.clone().multiply(mat(0, 0.7, 0)), '#7a5634'); for (const z of [-0.5, 0.5]) b.cyl(0.32, 0.32, 0.08, 10, m.clone().multiply(mat(0, 0.32, z, 0, Math.PI / 2)), '#3d3d3d'); }
  }
  // the workers' places (the station's crowd): along the platform edge and among the stacks
  for (let i = 0; i < 14; i++) { const q = at(k0 + 0.01 + r() * (k1 - k0 - 0.02), p0 + s * (0.8 + r() * 6.5)); spots.push({ x: q.x, y: q.y + GOODS_PF_H, z: q.z, heading: q.h }); }

  // the stacks: three layers (bottom, middle, top) as their own meshes, shown by how full the yard is
  const layers = [new GeoBatch(), new GeoBatch(), new GeoBatch()];
  const lots = 10;
  for (let i = 0; i < lots; i++) {
    const km = k0 + 0.012 + (i + 0.5) * (k1 - k0 - 0.024) / lots, kind = cargo[i % cargo.length];
    if (Math.abs(km - st.km) < shedHalf + 0.006 && i % 3 === 0) continue; // (an aisle in the shed)
    const q = at(km, mid + s * (1.2 + r() * 1.5)), base = mat(q.x, q.y + GOODS_PF_H, q.z, q.ry);
    stack(layers, base, kind, r);
  }
  const M = { ...(materials() as unknown as Record<string, THREE.Material>), cargo: cargoMaterial() };
  const meshes = layers.map(l => { const g = l.build(M); group.add(g); return g; });

  // the truck yard behind the platform: an apron, lorries backed up to it, a tractor and trailer
  const ty = (km: number, out: number) => at(km, p1 + s * out);
  const aq = ty(st.km, 9);
  b.box(300, 0.06, 16, mat(aq.x, aq.y + 0.04, aq.z, aq.ry), '#6a6862', 'concrete');
  const cab = ['#c0392b', '#2471a3', '#d68910', '#1e8449', '#f4f6f7'];
  for (let i = 0; i < 5; i++) {
    const q = ty(st.km - 0.11 + i * 0.05 + (r() - 0.5) * 0.01, 5.5), m = mat(q.x, q.y, q.z, q.ry + (s > 0 ? -Math.PI / 2 : Math.PI / 2));
    b.box(2.4, 2.4, 2.3, m.clone().multiply(mat(3.4, 1.7, 0)), cab[i % cab.length]);
    b.box(5.6, 0.4, 2.4, m.clone().multiply(mat(-0.6, 1.0, 0)), '#4a4a4a', 'metal');
    b.box(5.4, 1.6, 2.4, m.clone().multiply(mat(-0.6, 2.0, 0)), r() < 0.5 ? '#d4ac0d' : '#6e2c00');
    for (const x of [2.8, -1.6, -2.8]) for (const z of [-1.05, 1.05]) b.cyl(0.5, 0.5, 0.35, 12, m.clone().multiply(mat(x, 0.5, z, 0, Math.PI / 2)), '#1c1c1c');
  }
  const tq = ty(k1 - 0.04, 12), tm = mat(tq.x, tq.y, tq.z, tq.ry);
  b.box(2.4, 1.4, 1.6, tm.clone().multiply(mat(2.2, 1.3, 0)), '#c0392b');
  for (const z of [-0.9, 0.9]) { b.cyl(0.8, 0.8, 0.4, 12, tm.clone().multiply(mat(1.4, 0.8, z, 0, Math.PI / 2)), '#1c1c1c'); b.cyl(0.45, 0.45, 0.25, 10, tm.clone().multiply(mat(3.2, 0.45, z, 0, Math.PI / 2)), '#1c1c1c'); }
  b.box(4.2, 1.0, 2.2, tm.clone().multiply(mat(-1.8, 1.3, 0)), '#3d6b2a');

  const yard = {
    /** 0..1: how full the yard is (the stack layers shown) */
    setFill(f: number) { meshes.forEach((m, i) => { m.visible = f > i / 3 + 0.01 || i === 0; }); },
  };
  yard.setFill(0.3 + r() * 0.7); // (each yard as full as it is, until a train works there)
  return yard;
}

/** One lot of a cargo, in three layers (layers[0] the bottom): blocks in the cargo atlas's picture of it, else shapes. */
function stack(layers: GeoBatch[], base: THREE.Matrix4, kind: Cargo, r: () => number) {
  const ci = cargoInfo?.[CARGO_CELL[kind]];
  if (ci) {
    const [u0, v0, u1, v1] = ci.body;
    for (let L = 0; L < 3; L++) {
      const w = 5.2 - L * 0.8, h = 1.1, g = uvToRect(new THREE.BoxGeometry(w, h, 2.2 - L * 0.3), { u0, v0, u1, v1 });
      layers[L].add(g, base.clone().multiply(mat((r() - 0.5) * 0.3, h / 2 + L * h, 0)), '#ffffff', 'cargo');
    }
    return;
  }
  const box = (L: number, w: number, h: number, d: number, x: number, y: number, z: number, c: string, key = 'std') => layers[L].box(w, h, d, base.clone().multiply(mat(x, y, z)), c, key);
  const cyl = (L: number, rad: number, len: number, x: number, y: number, z: number, c: string, lying = true) => layers[L].cyl(rad, rad, len, 12, base.clone().multiply(mat(x, y, z, 0, lying ? Math.PI / 2 : 0)), c, 'metal');
  switch (kind) {
    case 'grain': case 'sugar': case 'fertiliser': case 'cement': {
      // sacks in brick-laid rows, each layer two courses
      const c = kind === 'grain' ? '#c9b48a' : kind === 'sugar' ? '#ecebe4' : kind === 'fertiliser' ? '#dfe7d7' : '#a8a9a6';
      for (let L = 0; L < 3; L++) for (let row = 0; row < 2; row++) {
        const y = 0.18 + (L * 2 + row) * 0.34, n = 6 - L;
        for (let i = 0; i < n; i++) for (const z of [-0.6, 0.0, 0.6]) box(L, 0.92, 0.32, 0.58, -2.6 + L * 0.45 + i * 1.0 + (row ? 0.45 : 0), y, z, c);
      }
      return;
    }
    case 'marble': case 'stone': {
      const c = kind === 'marble' ? '#f2f0ea' : '#8f8a84';
      for (let L = 0; L < 3; L++) for (let i = 0; i < 3 - (L > 1 ? 1 : 0); i++) box(L, 1.9, 1.2, 1.3, -2.2 + i * 2.1 + L * 0.3, 0.6 + L * 1.22, (r() - 0.5) * 0.4, c);
      return;
    }
    case 'salt': {
      for (let L = 0; L < 3; L++) layers[L].add(new THREE.ConeGeometry(2.4 - L * 0.6, 1.3, 12), base.clone().multiply(mat(0, 0.65 + L * 0.9, 0)), '#f4f4f2');
      return;
    }
    case 'fish': {
      for (let L = 0; L < 3; L++) for (let i = 0; i < 8; i++) box(L, 0.6, 0.32, 0.42, -2.1 + (i % 4) * 0.65, 0.17 + L * 0.34, i < 4 ? -0.25 : 0.25, i % 3 ? '#2f6db5' : '#e74c3c');
      return;
    }
    case 'tea': case 'cartons': {
      const c = kind === 'tea' ? '#8b6b4a' : '#c49a6c', sz = kind === 'tea' ? 0.6 : 0.5;
      box(0, 3.2, 0.12, 1.4, 0, 0.06, 0, '#9c7a4a');
      for (let L = 0; L < 3; L++) for (let i = 0; i < 5; i++) for (const z of [-0.33, 0.33]) box(L, sz, sz, sz, -1.3 + i * 0.65, 0.12 + sz / 2 + L * sz, z, c);
      return;
    }
    case 'timber': {
      for (let L = 0; L < 3; L++) for (let i = 0; i < 5 - L; i++) cyl(L, 0.3, 4.5, -1.2 + i * 0.62 + L * 0.31, 0.3 + L * 0.54, 0, '#8a6a4a');
      return;
    }
    case 'steel': {
      for (let L = 0; L < 3; L++) for (let i = 0; i < 3; i++) layers[L].cyl(0.75, 0.75, 1.2, 14, base.clone().multiply(mat(-2 + i * 1.7, 0.75 + L * 1.5, 0, 0, Math.PI / 2, 0)), '#7b8288', 'metal');
      return;
    }
  }
}
