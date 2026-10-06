import * as THREE from 'three/webgpu';
import { tex } from './Textures';
import { textures } from './TextureLibrary';

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
  // textured materials: GeoBatch boxes/cylinders and extruded strips use UVs in metres.
  // Materials used all along the line stay resident; station-only ones load when a station streams in.
  const brick = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
  textures.bind(brick, 'brick', tex.brick, 1, { resident: true });
  const stone = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  textures.bind(stone, 'stone', tex.stone, 1, { resident: true });
  const concrete = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 });
  textures.bind(concrete, 'concrete', tex.concrete, 1, { resident: true });
  const roof = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
  textures.bind(roof, 'roof', tex.roof, 1, { resident: true });
  const sheet = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.35 });
  textures.bind(sheet, 'sheet', tex.metalSheet, 1, { resident: true });
  const tunnel = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide });
  textures.bind(tunnel, 'tunnel', tex.tunnel, 1);
  const facade = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, emissiveMap: tex.facade(true), emissive: new THREE.Color(0xffffff), emissiveIntensity: 0 });
  // building template UVs: one unit = 12.4 m (4 floors x 4 windows); a real facade image has its own windows,
  // so the procedural lit-window mask is dropped when it loads
  textures.bind(facade, 'facade', () => tex.facade(false), 12.4, { resident: true, onFileLoaded: () => { facade.emissiveMap = null; facade.emissive.setRGB(0, 0, 0); } });
  // station-only surfaces (acquired by StationView)
  const platform = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
  textures.bind(platform, 'platform', tex.concrete, 1);
  const platformEdge = new THREE.MeshStandardMaterial({ roughness: 0.75, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  textures.bind(platformEdge, 'platformEdge', tex.platformEdge, 1);
  const wall = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88 });
  textures.bind(wall, 'wall', tex.brick, 1);
  // name board: a decal over the board (cut-out posts in the image), polygon offset so it never flickers on the plate behind
  const nameboard = new THREE.MeshStandardMaterial({ roughness: 0.6, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  textures.bind(nameboard, 'nameboard', tex.nameboard, 1);
  const label = new THREE.MeshStandardMaterial({ roughness: 0.6 });
  return { std, metal, glass, lamp, brick, stone, concrete, roof, sheet, tunnel, facade, label, platform, platformEdge, wall, nameboard };
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
