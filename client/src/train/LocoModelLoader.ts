import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { CoachData, LocoData, LocoModelFile } from '@rail/shared/train/Consist';
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
/** the loaded files themselves (one download however many parts are fitted from them) */
const raw = new Map<string, Promise<THREE.Object3D[]>>();

/**
 * The model settings for one section: for a trainset, car `section` only (its
 * x range of the source model), centred on the car; otherwise the model as is.
 */
export function partConfig(data: LocoData, section = 0): LocoModelFile {
  const cfg = data.model!, car = data.trainset?.cars[section];
  if (!car) return cfg;
  const centre = (car.keep[0] + car.keep[1]) / 2;
  return { ...cfg, keep: { axis: 0, min: car.keep[0], max: car.keep[1] }, offset: [cfg.offset[0] - centre * cfg.scale, cfg.offset[1], cfg.offset[2]] };
}

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

type PanelFile = NonNullable<NonNullable<LocoModelFile['cab']>['panel']>;

/**
 * A loco's separate driver's console (model.cab.panel): the optimised copy for
 * the quality preset (<id>-panel.<high|medium|lod1>.glb from `npm run models`),
 * else the source file. Not cached: the cab keeps it while needed and may drop it.
 */
export async function loadPanelScene(locoId: string, panel: PanelFile) {
  const l = gltfLoader();
  const opt = files(`${locoId}-panel`).near;
  try { return (await l.loadAsync(opt)).scene; }
  catch {
    console.warn(`[models] ${locoId}: optimised cab panel missing (${opt}) - loading the source ${panel.file}. Run "npm run models" for the small, compressed copy.`);
    return (await l.loadAsync(`${import.meta.env.BASE_URL}${panel.file}`)).scene;
  }
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
  // a bogie that is a single mesh node (WAG-9: each bogie with its wheels is one mesh): give it a group of
  // its own, or merging the bogie's parts below would take the mesh itself out of the model
  cfg.bogies.forEach(b => {
    if (Array.isArray(b.node)) return;
    const n = byName(scene, b.node);
    if (!n || !(n as THREE.Mesh).isMesh || !n.parent) return;
    const g = new THREE.Group();
    g.name = n.name;
    n.name = `${n.name}-mesh`;
    n.parent.add(g);
    g.updateMatrixWorld(true);
    g.attach(n);
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
export function loadLocoModel(data: LocoData, section = 0) {
  if (!data.model) return Promise.resolve(null);
  const cfg = partConfig(data, section);
  const key = data.trainset ? `${data.id}#${section}` : data.id;
  let p = cache.get(key);
  if (!p) {
    const f = files(data.id);
    const l = gltfLoader();
    const source = `${import.meta.env.BASE_URL}${cfg.file}`;
    // the scenes are cloned for each part fitted from them (fit removes the other parts' meshes)
    const scenes = (k: string, load: () => Promise<THREE.Object3D[]>) => { let r = raw.get(k); if (!r) raw.set(k, (r = load())); return r.then(s => s.map(x => x.clone(true))); };
    p = scenes(`${data.id}:opt`, () => Promise.all(LEVELS.map(k => l.loadAsync(f[k]).then(g => g.scene))))
      .then(([near, mid, far]) => ({ near: fit(near, cfg), mid: fit(mid, cfg), far: fit(far, cfg) }))
      // not optimised yet (npm run models not run): use the source file for every level - slower to
      // load and heavier to draw, with the source livery, but enough to try a new model straight away
      .catch(async () => {
        console.warn(`[models] ${data.id}: optimised files missing (${f.near}) - loading the source ${cfg.file}. Run "npm run models" for the fast, compressed version.`);
        const [g] = await scenes(`${data.id}:src`, () => l.loadAsync(source).then(x => [x.scene]));
        const t = fit(g, cfg); // every level copies this one template
        return { near: t, mid: t, far: t };
      })
      .catch(err => {
        console.warn(`[models] ${data.id}: could not load the 3D model - keeping the procedural model.`, err);
        return null;
      });
    cache.set(key, p);
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

/** One level of detail of a coach model: a mesh per material, everything in the coach frame (+x along, y up from rail top, centred). */
export type CoachLevel = { geometry: THREE.BufferGeometry; material: THREE.Material }[];
const coachCache = new Map<string, Promise<Record<(typeof LEVELS)[number], CoachLevel> | null>>();

/** Bake a fitted coach into plain geometry per material (the transforms applied, parts with one material merged). */
function coachLevel(fitted: THREE.Group): CoachLevel {
  fitted.updateMatrixWorld(true);
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  fitted.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = plainGeometry(m, m.matrixWorld);
    const list = byMat.get(m.material as THREE.Material) ?? [];
    list.push(g);
    byMat.set(m.material as THREE.Material, list);
  });
  const out: CoachLevel = [];
  for (const [material, list] of byMat) {
    const geometry = list.length > 1 ? mergeGeometries(list, false) : list[0];
    if (!geometry) continue;
    geometry.computeBoundingSphere();
    out.push({ geometry, material });
  }
  return out;
}

/**
 * A coach's 3D model (data/coaches model), its three levels of detail baked for instancing. Only the
 * optimised files are used (coach sources are far too heavy to draw a rake of): when they are missing
 * the procedural coach stays and a warning says to run `npm run models`.
 */
export function loadCoachModel(c: CoachData) {
  if (!c.model) return Promise.resolve(null);
  let p = coachCache.get(c.id);
  if (!p) {
    const f = files(`coach-${c.id}`), l = gltfLoader();
    const cfg = { ...c.model, bogies: [], pantographs: [], hideInCab: [], lights: { head: [0, 0], markers: [0, 0, 0] } } as LocoModelFile;
    p = Promise.all(LEVELS.map(k => l.loadAsync(f[k]).then(g => g.scene)))
      .then(([near, mid, far]) => ({ near: coachLevel(fit(near, cfg)), mid: coachLevel(fit(mid, cfg)), far: coachLevel(fit(far, cfg)) }))
      .catch(err => {
        console.warn(`[models] coach ${c.id}: optimised files missing (${f.near}) - the procedural coach is kept. Run "npm run models".`, err);
        return null;
      });
    coachCache.set(c.id, p);
  }
  return p;
}
