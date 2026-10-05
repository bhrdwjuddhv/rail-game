import * as THREE from 'three/webgpu';
import TEXTURES from '../../../data/textures.json';
import { settings } from './Settings';

interface ProcessedSet { size: [number, number]; color: string; normal?: string; roughness?: string; ktx2?: string }
interface TextureEntry { file: string; tilingM: number; tileable: boolean; normal: boolean; alphaTest?: number; materials: string[]; processed?: { full: ProcessedSet; half: ProcessedSet } }
const TEX = TEXTURES as unknown as { textures: Record<string, TextureEntry>; ui: Record<string, string> };

/**
 * One API for procedural and file-based assets. Every asset has an id; the
 * game always asks for it with a procedural factory. If
 * public/assets/manifest.json maps that id to a file (.glb / .ktx2 / .png /
 * .ogg), the file is loaded and swapped in - no code changes needed.
 *
 *   { "model:loco/ep-7": "assets/ep7.glb", "tex:terrain/ground": "assets/ground.ktx2", "audio:horn/low": "assets/horn.ogg" }
 */
export class AssetRegistry {
  private manifest: Record<string, string> = {};
  private renderer?: unknown;
  private audioCache = new Map<string, Promise<AudioBuffer | null>>();

  async init(renderer: unknown) {
    this.renderer = renderer;
    try {
      const r = await fetch(`${import.meta.env.BASE_URL}assets/manifest.json`);
      if (r.ok) this.manifest = await r.json();
    } catch { /* no manifest: everything stays procedural */ }
  }

  has(id: string) { return id in this.manifest; }

  /** Estimated GPU memory of file textures loaded so far (RGBA8 + mip chain), MB. */
  textureMB = 0;

  /**
   * Bind a texture set from data/textures.json to a material. The procedural
   * texture is used immediately; if `npm run textures` produced files for this
   * id they replace it (colour + normal + roughness). Missing files never break
   * anything - no request is even made unless the manifest lists processed output.
   *
   * uvMeters: how many metres one UV unit spans on the geometry using this
   * material; repeat = uvMeters / tilingM so textures keep their real-world size.
   * Budget (keeps High well under ~500 MB): High/Ultra = full-size colour + half-size
   * normal/roughness; Medium = half-size everything; Low = half-size colour only.
   */
  bindTextureSet(mat: THREE.MeshStandardMaterial, id: string, factory: () => THREE.Texture, uvMeters = 1, onFileLoaded?: () => void) {
    const entry = TEX.textures[id];
    const repeat = entry?.tileable ? uvMeters / entry.tilingM : 1;
    const proc = factory().clone();
    proc.needsUpdate = true;
    if (entry?.tileable) { proc.wrapS = proc.wrapT = THREE.RepeatWrapping; proc.repeat.set(repeat, repeat); }
    mat.map = proc;
    if (entry?.alphaTest) mat.alphaTest = entry.alphaTest;
    const set = entry?.processed;
    if (!set) return;
    const q = settings.get().quality;
    const colorSet = q === 'high' || q === 'ultra' ? set.full : set.half;
    const aniso = q === 'low' ? 4 : 8;
    const base = `${import.meta.env.BASE_URL}assets/`;
    const loader = new THREE.TextureLoader();
    const prep = (t: THREE.Texture, srgb: boolean, [w, h]: [number, number]) => {
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = t.wrapT = entry.tileable ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
      t.repeat.set(repeat, repeat);
      t.anisotropy = aniso;
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      this.textureMB += (w * h * 4 * 1.33) / 1048576;
      return t;
    };
    loader.loadAsync(base + colorSet.color).then(t => {
      mat.map = prep(t, true, colorSet.size);
      mat.needsUpdate = true;
      onFileLoaded?.();
    }).catch(e => console.warn(`[textures] ${id}: ${colorSet.color} failed, keeping procedural`, e));
    if (q === 'low' || !set.half.normal) return;
    loader.loadAsync(base + set.half.normal).then(t => { mat.normalMap = prep(t, false, set.half.size); mat.normalScale.set(0.9, 0.9); mat.needsUpdate = true; }).catch(() => {});
    if (set.half.roughness) loader.loadAsync(base + set.half.roughness).then(t => { mat.roughnessMap = prep(t, false, set.half.size); mat.roughness = 1; mat.needsUpdate = true; }).catch(() => {});
  }

  /** URL of a UI image (webp preferred, then png), or null when missing. Probed with Image() so a miss is silent. */
  uiImage(name: string): Promise<string | null> {
    const rel = TEX.ui?.[name];
    if (!rel) return Promise.resolve(null);
    const base = `${import.meta.env.BASE_URL}assets/${rel}`;
    const tryUrl = (url: string) => new Promise<string | null>(res => { const i = new Image(); i.onload = () => res(url); i.onerror = () => res(null); i.src = url; });
    return tryUrl(base + '.webp').then(u => u ?? tryUrl(base + '.png'));
  }

  /** Returns a group holding the procedural model now; replaced by the file model once loaded. */
  model(id: string, factory: () => THREE.Object3D): THREE.Group {
    const g = new THREE.Group();
    g.name = id;
    g.add(factory());
    const url = this.manifest[`model:${id}`];
    if (url) {
      import('three/addons/loaders/GLTFLoader.js').then(({ GLTFLoader }) =>
        new GLTFLoader().loadAsync(url).then(gltf => {
          g.clear();
          gltf.scene.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
          g.add(gltf.scene);
        }),
      ).catch(e => console.warn(`asset ${id} failed, keeping procedural`, e));
    }
    return g;
  }

  /** Assign a texture to material[slot]; a file texture replaces the procedural one when loaded. */
  bindTexture(mat: THREE.Material, slot: 'map' | 'normalMap' | 'emissiveMap' | 'roughnessMap', id: string, factory: () => THREE.Texture) {
    const proc = factory();
    (mat as any)[slot] = proc;
    const url = this.manifest[`tex:${id}`];
    if (!url) return;
    const apply = (t: THREE.Texture) => {
      t.wrapS = proc.wrapS; t.wrapT = proc.wrapT; t.repeat.copy(proc.repeat); t.colorSpace = proc.colorSpace;
      (mat as any)[slot] = t;
      mat.needsUpdate = true;
    };
    if (url.endsWith('.ktx2')) {
      import('three/addons/loaders/KTX2Loader.js').then(({ KTX2Loader }) => {
        const l = new KTX2Loader().setTranscoderPath('https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/libs/basis/');
        if (this.renderer) l.detectSupport(this.renderer as any);
        return l.loadAsync(url).then(apply);
      }).catch(e => console.warn(`texture ${id} failed`, e));
    } else {
      new THREE.TextureLoader().loadAsync(url).then(apply).catch(e => console.warn(`texture ${id} failed`, e));
    }
  }

  /** Decoded audio file for this id, or null to use the synthesiser. */
  audio(ctx: BaseAudioContext, id: string): Promise<AudioBuffer | null> {
    const url = this.manifest[`audio:${id}`];
    if (!url) return Promise.resolve(null);
    let p = this.audioCache.get(id);
    if (!p) {
      p = fetch(url).then(r => r.arrayBuffer()).then(b => ctx.decodeAudioData(b)).catch(() => null);
      this.audioCache.set(id, p);
    }
    return p;
  }
}

export const assets = new AssetRegistry();
