import * as THREE from 'three/webgpu';
import TEXTURES from '../../../data/textures.json';

const TEX = TEXTURES as unknown as { ui: Record<string, string> };

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
        const l = new KTX2Loader().setTranscoderPath(`${import.meta.env.BASE_URL}basis/`);
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
