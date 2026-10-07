import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { LocoData, LocoModelFile } from '@rail/shared/train/Consist';
import { settings } from '../core/Settings';
import { CONTACT_H } from '../infrastructure/OHE';

/**
 * A single-arm pantograph rig in the model frame ((z, y) plane): the lower
 * arm pivots at its base, the upper arm (with the pan head) at the knee.
 * Down, both arms lie almost flat on the roof (the upper folded back over the
 * lower); up, the head touches the contact wire. In between the arm angles
 * are interpolated, as the real linkage swings.
 */
export interface PantoRig {
  lower: THREE.Object3D; upper: THREE.Object3D; joint: THREE.Object3D | null;
  base: THREE.Vector2; l1: number; l2: number;
  lowerQ: THREE.Quaternion; upperQ: THREE.Quaternion;
  /** arm angles (radians, from +z toward +y): as modelled, on the wire, folded down */
  rest: [number, number]; up: [number, number]; down: [number, number];
}

const ang = (v: THREE.Vector2) => Math.atan2(v.y, v.x);

/** Two-link solve: knee for base B and head H with arm lengths l1, l2, on the same side as `ref` knee. */
function solveKnee(B: THREE.Vector2, H: THREE.Vector2, l1: number, l2: number, ref: THREE.Vector2) {
  const d = Math.max(1e-6, H.distanceTo(B));
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const k = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const dir = H.clone().sub(B).divideScalar(d);
  const mid = B.clone().addScaledVector(dir, a);
  const perp = new THREE.Vector2(-dir.y, dir.x);
  const k1 = mid.clone().addScaledVector(perp, k), k2 = mid.clone().addScaledVector(perp, -k);
  return k1.distanceTo(ref) < k2.distanceTo(ref) ? k1 : k2;
}

/** One fitted level of detail: everything in the loco body frame (+x front, y up from rail top). */
export interface GlbLevel {
  root: THREE.Group;
  /** front and rear bogie holders, origin at the bogie centre on the rail (TrainView turns them) */
  bogies: THREE.Object3D[];
  /** wheelsets: spun about their own local axle (+x of the model) */
  wheels: THREE.Object3D[];
  pantos: PantoRig[];
  /** the model's cab interior / glazing / wipers, hidden in the cab view */
  cab: THREE.Object3D[];
}

const LEVELS = ['near', 'mid', 'far'] as const;
let renderer: unknown = null;
let loader: GLTFLoader | null = null;
const cache = new Map<string, Promise<Record<(typeof LEVELS)[number], THREE.Group> | null>>();

/** Set once at start-up (KTX2 needs the renderer to pick a GPU format). */
export function initModelLoader(r: unknown) { renderer = r; }

function gltfLoader() {
  if (loader) return loader;
  const ktx2 = new KTX2Loader().setTranscoderPath(`${import.meta.env.BASE_URL}basis/`).setWorkerLimit(2);
  if (renderer) ktx2.detectSupport(renderer as never);
  loader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
  return loader;
}

/** Optimised files written by `npm run models`, by level, for the current quality preset. */
function files(id: string) {
  const q = settings.get().quality;
  const near = q === 'low' ? 'lod1' : q === 'medium' ? 'medium' : 'high';
  const base = `${import.meta.env.BASE_URL}assets/models/_processed/${id}`;
  return { near: `${base}.${near}.glb`, mid: `${base}.lod1.glb`, far: `${base}.lod2.glb` };
}

/** Float32 position / normal / uv only, in the model root's frame, so different parts can merge. */
function plainGeometry(mesh: THREE.Mesh, toRoot: THREE.Matrix4) {
  const src = mesh.geometry as THREE.BufferGeometry;
  const g = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const a = src.getAttribute(name) as THREE.BufferAttribute | undefined;
    if (!a) continue;
    const out = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) out[i * a.itemSize + k] = a.getComponent(i, k);
    g.setAttribute(name, new THREE.BufferAttribute(out, a.itemSize));
  }
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
  if (src.index) g.setIndex(Array.from(src.index.array as ArrayLike<number>));
  g.applyMatrix4(toRoot);
  return g;
}

/**
 * Merge every mesh under `parts` (except those under `keep`) into one mesh per
 * material, re-parented to `into`. Moving parts are kept out; the parts they
 * leave behind are removed from the tree.
 */
function mergeStatic(parts: THREE.Object3D[], into: THREE.Object3D, keep: Set<THREE.Object3D>, rootInv: THREE.Matrix4) {
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const done: THREE.Mesh[] = [];
  const kept = (o: THREE.Object3D) => { for (let p: THREE.Object3D | null = o; p; p = p.parent) if (keep.has(p)) return true; return false; };
  for (const p of parts) p.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || kept(m)) return;
    const mat = m.material as THREE.Material;
    const list = byMat.get(mat) ?? [];
    list.push(plainGeometry(m, new THREE.Matrix4().multiplyMatrices(rootInv, m.matrixWorld)));
    byMat.set(mat, list);
    done.push(m);
  });
  for (const m of done) m.removeFromParent();
  for (const [mat, list] of byMat) {
    const g = mergeGeometries(list, false);
    if (!g) continue;
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = mesh.receiveShadow = true;
    into.add(mesh);
  }
}

/** Find a node by its exact glTF name (GLTFLoader may sanitise names: compare both). */
function byName(root: THREE.Object3D, name: string) {
  const clean = THREE.PropertyBinding.sanitizeNodeName(name);
  return root.getObjectByName(name) ?? root.getObjectByName(clean) ?? null;
}

/** Name given to a bogie made of several nodes (grouped by `fit`). */
export const bogieName = (b: LocoModelFile['bogies'][number], i: number) => (Array.isArray(b.node) ? `glb-bogie-${i}` : b.node);

/** Bounds centre of a node in the scene root's frame. */
function centreInScene(o: THREE.Object3D, sceneInv: THREE.Matrix4) {
  const box = new THREE.Box3().setFromObject(o);
  return box.isEmpty() ? null : box.getCenter(new THREE.Vector3()).applyMatrix4(sceneInv);
}

/** Fit one loaded scene: scale / rotate / offset from the data, materials, merges. Returns the template root. */
function fit(scene: THREE.Object3D, cfg: LocoModelFile) {
  const fitted = new THREE.Group();
  const model = new THREE.Group();
  model.add(scene);
  model.position.fromArray(cfg.offset);
  model.rotation.set(...(cfg.rotationDeg.map(d => THREE.MathUtils.degToRad(d)) as [number, number, number]), 'XYZ');
  model.scale.setScalar(cfg.scale);
  fitted.add(model);
  fitted.updateMatrixWorld(true);
  const sceneInv0 = new THREE.Matrix4().copy(scene.matrixWorld).invert();
  // only part of the file (one section of a twin loco), and pantograph arms replaced by ours
  const drop = new Set([...(cfg.proceduralPantographs?.remove ?? []), ...(cfg.remove ?? [])].map(n => byName(scene, n)).filter(Boolean));
  if (cfg.keep || drop.size) {
    const meshes: THREE.Object3D[] = [];
    scene.traverse(o => { if ((o as THREE.Mesh).isMesh) meshes.push(o); });
    const k = cfg.keep;
    for (const m of meshes) {
      let gone = false;
      for (let p: THREE.Object3D | null = m; p && p !== scene; p = p.parent) if (drop.has(p)) gone = true;
      if (!gone && k) {
        const c = centreInScene(m, sceneInv0);
        const v = c ? c.getComponent(k.axis) : 0;
        gone = v < (k.min ?? -Infinity) || v > (k.max ?? Infinity);
      }
      if (gone) m.removeFromParent();
    }
  }
  // bogies made of several nodes: group them (keeping their world transforms)
  cfg.bogies.forEach((b, i) => {
    if (!Array.isArray(b.node)) return;
    const parts = b.node.map(n => byName(scene, n)).filter((n): n is THREE.Object3D => !!n);
    if (!parts.length) return;
    const g = new THREE.Group();
    g.name = bogieName(b, i);
    const c = new THREE.Box3();
    for (const p of parts) c.expandByObject(p);
    g.position.copy(c.getCenter(new THREE.Vector3()).applyMatrix4(sceneInv0));
    scene.add(g);
    g.updateMatrixWorld(true);
    for (const p of parts) g.attach(p);
  });
  fitted.updateMatrixWorld(true);
  // a plain lit look, and shadows; window glass see-through (tagged by the optimiser, or by name in a source file)
  const glassNames = new Set(cfg.glassMaterials ?? []);
  scene.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mat = m.material as THREE.MeshStandardMaterial;
    if (mat.userData?.rbGlass || glassNames.has(mat.name)) {
      mat.transparent = true; mat.opacity = 0.14; mat.depthWrite = false; mat.roughness = 0.05; mat.metalness = 0.4;
      mat.color.setRGB(0.55, 0.65, 0.7);
      m.castShadow = false; m.renderOrder = 3;
      return;
    }
    if (cfg.look && mat.isMeshStandardMaterial) { mat.roughness = cfg.look.roughness; mat.metalness = cfg.look.metalness; }
    m.castShadow = m.receiveShadow = true;
  });
  // merge the static body per material: moving parts and cab parts stay separate
  const moving = new Set<THREE.Object3D>();
  cfg.bogies.forEach((b, i) => { const n = byName(scene, bogieName(b, i)); if (n) moving.add(n); });
  for (const p of cfg.pantographs) for (const k of [p.lower, p.upper, p.joint]) { const n = k ? byName(scene, k) : null; if (n) moving.add(n); }
  const cabNodes = cfg.hideInCab.map(n => byName(scene, n)).filter((n): n is THREE.Object3D => !!n);
  const cabGroup = new THREE.Group();
  cabGroup.name = 'glb-cab';
  const sceneInv = new THREE.Matrix4().copy(scene.matrixWorld).invert();
  mergeStatic(cabNodes, cabGroup, moving, sceneInv);
  scene.add(cabGroup);
  const staticGroup = new THREE.Group();
  staticGroup.name = 'glb-static';
  mergeStatic([scene], staticGroup, new Set([...moving, cabGroup]), sceneInv);
  scene.add(staticGroup);
  // bogie internals: merge per bogie, wheels kept
  for (const [i, b] of cfg.bogies.entries()) {
    const n = byName(scene, bogieName(b, i));
    if (!n) continue;
    const wheels = new Set(b.wheels.map(w => byName(n, w)).filter((w): w is THREE.Object3D => !!w));
    const frame = new THREE.Group();
    frame.name = 'glb-bogie-frame';
    n.updateMatrixWorld(true);
    mergeStatic([n], frame, wheels, new THREE.Matrix4().copy(n.matrixWorld).invert());
    n.add(frame);
  }
  return fitted;
}

/**
 * Load (once per loco type) the three fitted levels of a loco's 3D model.
 * Resolves to null when the files are missing or broken: the procedural
 * model then simply stays (a warning says why).
 */
export function loadLocoModel(data: LocoData) {
  const cfg = data.model;
  if (!cfg) return Promise.resolve(null);
  let p = cache.get(data.id);
  if (!p) {
    const f = files(data.id);
    const l = gltfLoader();
    const source = `${import.meta.env.BASE_URL}${cfg.file}`;
    p = Promise.all(LEVELS.map(k => l.loadAsync(f[k])))
      .then(([near, mid, far]) => ({ near: fit(near.scene, cfg), mid: fit(mid.scene, cfg), far: fit(far.scene, cfg) }))
      // not optimised yet (npm run models not run): use the source file for every level - slower to
      // load and heavier to draw, with the source livery, but enough to try a new model straight away
      .catch(async () => {
        console.warn(`[models] ${data.id}: optimised files missing (${f.near}) - loading the source ${cfg.file}. Run "npm run models" for the fast, compressed version.`);
        const g = await l.loadAsync(source);
        const t = fit(g.scene, cfg); // every level copies this one template
        return { near: t, mid: t, far: t };
      })
      .catch(err => {
        console.warn(`[models] ${data.id}: could not load the 3D model - keeping the procedural model.`, err);
        return null;
      });
    cache.set(data.id, p);
  }
  return p;
}

/** A per-instance copy of a fitted level with its moving parts found and rigged. */
export function instanceLevel(template: THREE.Group, cfg: LocoModelFile): GlbLevel {
  const root = template.clone(true);
  root.traverse(o => { o.userData.sharedGeometry = true; });
  root.updateMatrixWorld(true);
  const scene = root.children[0].children[0];
  const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const level: GlbLevel = { root, bogies: [], wheels: [], pantos: [], cab: [] };
  const cab = scene.getObjectByName('glb-cab');
  if (cab) level.cab.push(cab);
  // bogies: re-parent into holders whose origin is the bogie centre on the rail
  const holders: { x: number; h: THREE.Object3D }[] = [];
  for (const [i, b] of cfg.bogies.entries()) {
    const n = byName(scene, bogieName(b, i));
    if (!n) continue;
    const box = new THREE.Box3().setFromObject(n);
    if (box.isEmpty()) continue;
    const centre = box.getCenter(new THREE.Vector3()).applyMatrix4(rootInv);
    const h = new THREE.Object3D();
    h.position.set(centre.x, 0, 0);
    const local = new THREE.Matrix4().makeTranslation(-centre.x, 0, 0).multiply(new THREE.Matrix4().multiplyMatrices(rootInv, n.matrixWorld));
    n.removeFromParent();
    local.decompose(n.position, n.quaternion, n.scale);
    h.add(n);
    holders.push({ x: centre.x, h });
    for (const w of b.wheels) { const wn = byName(n, w); if (wn) { wn.userData.restQ = wn.quaternion.clone(); level.wheels.push(wn); } }
  }
  holders.sort((a, b) => b.x - a.x); // front bogie first
  level.bogies = holders.map(x => x.h);
  // pantographs: rest geometry in the model frame (z along the loco, y up)
  for (const p of cfg.pantographs) {
    const lower = byName(scene, p.lower), upper = byName(scene, p.upper);
    if (!lower || !upper) continue;
    const joint = p.joint ? byName(scene, p.joint) : null;
    const base = new THREE.Vector2(lower.position.z, lower.position.y);
    const knee0 = new THREE.Vector2(upper.position.z, upper.position.y);
    // the pan head is the far end of the upper arm: twice its centre's distance from the knee
    const ub = new THREE.Box3().setFromObject(upper);
    const sceneInv = new THREE.Matrix4().copy(scene.matrixWorld).invert();
    const uc = ub.getCenter(new THREE.Vector3()).applyMatrix4(sceneInv);
    const head0 = new THREE.Vector2(knee0.x + 2 * (uc.z - knee0.x), knee0.y + 2 * (uc.y - knee0.y));
    const l1 = knee0.distanceTo(base), l2 = head0.distanceTo(knee0);
    const rest: [number, number] = [ang(knee0.clone().sub(base)), ang(head0.clone().sub(knee0))];
    // up: the head on the contact wire, straight above where it was modelled
    const headUp = new THREE.Vector2(head0.x, (CONTACT_H - cfg.offset[1]) / cfg.scale);
    const kneeUp = solveKnee(base, headUp, l1, l2, knee0);
    const up: [number, number] = [ang(kneeUp.clone().sub(base)), ang(headUp.clone().sub(kneeUp))];
    // down: lower arm a few degrees above flat in its own direction, upper folded back over it
    const flat = (a: number, e: number) => (Math.cos(a) >= 0 ? e : Math.PI - e);
    const down: [number, number] = [flat(rest[0], 0.08), flat(rest[0] + Math.PI, -0.05)];
    level.pantos.push({ lower, upper, joint, base, l1, l2, lowerQ: lower.quaternion.clone(), upperQ: upper.quaternion.clone(), rest, up, down });
  }
  return level;
}

const _qx = new THREE.Quaternion(), _x = new THREE.Vector3(1, 0, 0);

/** Pose a pantograph rig: pos 0 = down, 1 = pan head on the contact wire. */
export function poseRig(r: PantoRig, pos: number) {
  const aL = r.down[0] + (r.up[0] - r.down[0]) * pos;
  const aU = r.down[1] + (r.up[1] - r.down[1]) * pos;
  const knee = new THREE.Vector2(r.base.x + Math.cos(aL) * r.l1, r.base.y + Math.sin(aL) * r.l1);
  // rotations about the model's x axis (across the loco), relative to the modelled pose:
  // an angle growing from +z toward +y is a rotation about +x by minus that angle
  r.lower.quaternion.copy(_qx.setFromAxisAngle(_x, -(aL - r.rest[0]))).multiply(r.lowerQ);
  r.upper.position.z = knee.x; r.upper.position.y = knee.y;
  r.upper.quaternion.copy(_qx.setFromAxisAngle(_x, -(aU - r.rest[1]))).multiply(r.upperQ);
  if (r.joint) { r.joint.position.z = knee.x; r.joint.position.y = knee.y; }
}
