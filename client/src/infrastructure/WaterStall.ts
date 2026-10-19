import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

/**
 * The platform drinking-water stall (model: "Railway Startion Water Stall" by the_cgi_guy, CC BY 4.0; see
 * CREDITS.md): loaded once (the copy from `npm run models`, else the source file) and drawn instanced, one
 * InstancedMesh per part per station. Local frame as Station's boxes: x along the line, y up, z across.
 */
const FILE = 'assets/models/_processed/station/drinkingwater.glb', SOURCE = 'assets/station/drinkingwater.glb';
/** the source model is 0.46 m long: at 8x a 3.7 m stall, 1.37 m high, its taps 0.9 m up */
const SCALE = 8;
/** half its length and depth (m), for keeping benches and people off it */
export const STALL_HALF = { along: 1.9, across: 0.4 };

/** a part: its geometry as loaded (Meshopt-quantized: never transformed itself), placed by `local` within the stall */
type Part = { geo: THREE.BufferGeometry; mat: THREE.Material | THREE.Material[]; local: THREE.Matrix4 };
let parts: Promise<Part[]> | null = null;

function load(): Promise<Part[]> {
  if (parts) return parts;
  const l = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder), base = import.meta.env.BASE_URL;
  parts = l.loadAsync(base + FILE).catch(() => l.loadAsync(base + SOURCE)).then(g => {
    g.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(g.scene), c = box.getCenter(new THREE.Vector3());
    // centred on its footprint and standing on y 0, its length (the model's z) along the line, at real size
    const fit = new THREE.Matrix4().makeScale(SCALE, SCALE, SCALE)
      .multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2))
      .multiply(new THREE.Matrix4().makeTranslation(-c.x, -box.min.y, -c.z));
    const out: Part[] = [];
    g.scene.traverse(o => {
      const m = o as THREE.Mesh;
      if (m.isMesh) out.push({ geo: m.geometry, mat: m.material, local: new THREE.Matrix4().multiplyMatrices(fit, m.matrixWorld) });
    });
    return out;
  });
  return parts;
}

/** Adds the stalls (local matrices in the group's frame) once the model is in; `gone()`: the station was disposed meanwhile. */
export function addWaterStalls(group: THREE.Group, at: THREE.Matrix4[], gone: () => boolean) {
  if (!at.length) return;
  load().then(ps => {
    if (gone()) return;
    for (const p of ps) {
      const im = new THREE.InstancedMesh(p.geo, p.mat, at.length);
      const m = new THREE.Matrix4();
      at.forEach((a, i) => im.setMatrixAt(i, m.multiplyMatrices(a, p.local)));
      im.castShadow = im.receiveShadow = true;
      im.computeBoundingSphere();
      group.add(im);
    }
  }).catch(e => console.warn('drinking water stall: model failed to load', e));
}
