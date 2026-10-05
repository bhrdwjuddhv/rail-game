import * as THREE from 'three/webgpu';
import { tex } from './Textures';
import { assets } from './AssetRegistry';

/**
 * Shared materials. Most static geometry uses vertex colours so whole
 * structures merge into one draw call per material.
 */
let built: ReturnType<typeof build> | null = null;

function build() {
  const std = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0 });
  const metal = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.6 });
  const glass = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.08, metalness: 0.4, transparent: true, opacity: 0.55 });
  /** Lamps: brightness driven by Lighting each frame (night = bloom). */
  const lamp = new THREE.MeshBasicMaterial({ vertexColors: true });
  // textured materials: GeoBatch boxes/cylinders and extruded strips use UVs in metres
  const brick = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
  assets.bindTextureSet(brick, 'structure/brick', tex.brick, 1);
  const stone = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  assets.bindTextureSet(stone, 'structure/stone', tex.stone, 1);
  const concrete = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 });
  assets.bindTextureSet(concrete, 'structure/concrete', tex.concrete, 1);
  const roof = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
  assets.bindTextureSet(roof, 'structure/roof-tiles', tex.roof, 1);
  const sheet = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.35 });
  assets.bindTextureSet(sheet, 'structure/metal-sheet', tex.metalSheet, 1);
  const tunnel = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide });
  assets.bindTextureSet(tunnel, 'structure/tunnel-rock', tex.tunnel, 1);
  const facade = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, emissiveMap: tex.facade(true), emissive: new THREE.Color(0xffffff), emissiveIntensity: 0 });
  // building template UVs: one unit = 12.4 m (4 floors x 4 windows); a real facade image has its own windows,
  // so the procedural lit-window mask is dropped when it loads
  assets.bindTextureSet(facade, 'building/facade', () => tex.facade(false), 12.4, () => { facade.emissiveMap = null; facade.emissive.setRGB(0, 0, 0); });
  const label = new THREE.MeshStandardMaterial({ roughness: 0.6 });
  return { std, metal, glass, lamp, brick, stone, concrete, roof, sheet, tunnel, facade, label };
}

export function materials() { return (built ??= build()); }

export type MaterialSet = ReturnType<typeof build>;

const labelMats = new Map<THREE.Texture, THREE.MeshStandardMaterial>();
/** Material for a text texture; emissive so boards stay readable in the headlight. */
export function labelMaterial(t: THREE.Texture) {
  let m = labelMats.get(t);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ map: t, roughness: 0.55, emissive: new THREE.Color(0xffffff), emissiveMap: t, emissiveIntensity: 0.05 });
    labelMats.set(t, m);
  }
  return m;
}
export const allLabelMaterials = () => labelMats.values();
