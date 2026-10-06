import * as THREE from 'three/webgpu';
import { effective, settings } from '../core/Settings';
import { textures } from '../core/TextureLibrary';
import { LAYER, LAYER_COUNT, LAYERS } from './terrainLayers';

/**
 * The terrain texture layers (data/textures.json "terrain:<layer>") as one
 * texture array, sampled by the terrain shader with per-vertex splat weights.
 * KTX2 layers stay GPU-compressed (CompressedArrayTexture) when they all
 * transcode to the same format and size; otherwise the WebP/decoded images go
 * into an RGBA DataArrayTexture. Until it is ready (or if a layer is missing)
 * the terrain keeps its vertex-colour look.
 */
export class TerrainTextures {
  readonly uniforms = {
    uSplat: { value: null as THREE.Texture | null },
    uSplatReady: { value: 0 },
    /** 1 / metres per copy, per layer */
    uLayerScale: { value: new Array<number>(LAYER_COUNT).fill(0.25) },
    /** 1 = the layer may be rotated for anti-repetition (not rows, strata) */
    uLayerRot: { value: new Array<number>(LAYER_COUNT).fill(0) },
  };
  /** shader quality: 0 = 2 layers, flat rock; 1 = 4 layers, triplanar rock; 2 = + two-scale anti-repetition */
  readonly quality: number;
  readonly ready: Promise<boolean>;

  constructor() {
    const q = settings.get().quality;
    this.quality = q === 'low' ? 0 : q === 'medium' ? 1 : 2;
    this.ready = this.build();
  }

  private async build() {
    const items = await Promise.all(LAYERS.map(n => textures.loadRaw(`terrain:${n}`)));
    const missing = LAYERS.filter((_, i) => !items[i]);
    if (missing.length) {
      console.info(`[textures] terrain layers without files (${missing.join(', ')}): vertex-colour terrain in use`);
      for (const it of items) it?.tex.dispose();
      return false;
    }
    const list = items as { tex: THREE.Texture; entry: { sizeM: [number, number]; rotate: boolean } }[];
    list.forEach((it, i) => { this.uniforms.uLayerScale.value[i] = 1 / it.entry.sizeM[0]; this.uniforms.uLayerRot.value[i] = it.entry.rotate ? 1 : 0; });
    const arr = this.compressedArray(list.map(i => i.tex)) ?? this.rgbaArray(list.map(i => i.tex));
    for (const it of list) it.tex.dispose();
    arr.wrapS = arr.wrapT = THREE.RepeatWrapping;
    arr.colorSpace = THREE.SRGBColorSpace;
    arr.magFilter = THREE.LinearFilter;
    arr.minFilter = THREE.LinearMipmapLinearFilter;
    arr.anisotropy = this.quality === 2 ? 8 : this.quality === 1 ? 4 : 2;
    arr.needsUpdate = true;
    textures.upload(arr);
    this.uniforms.uSplat.value = arr;
    this.uniforms.uSplatReady.value = 1;
    return true;
  }

  /** All layers block-compressed in the same format and size: stack them without decompressing. */
  private compressedArray(texs: THREE.Texture[]): THREE.Texture | null {
    const c = texs as THREE.CompressedTexture[];
    if (!c.every(t => t.isCompressedTexture && t.mipmaps?.length)) return null;
    const f = c[0], levels = Math.min(...c.map(t => t.mipmaps.length));
    if (!c.every(t => t.format === f.format && t.mipmaps[0].width === f.mipmaps[0].width && t.mipmaps[0].height === f.mipmaps[0].height)) return null;
    const mipmaps: { data: Uint8Array; width: number; height: number }[] = [];
    let bytes = 0;
    for (let l = 0; l < levels; l++) {
      const parts = c.map(t => t.mipmaps[l].data as Uint8Array);
      const data = new Uint8Array(parts.reduce((a, p) => a + p.byteLength, 0));
      let o = 0;
      for (const p of parts) { data.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), o); o += p.byteLength; }
      mipmaps.push({ data, width: f.mipmaps[l].width, height: f.mipmaps[l].height });
      bytes += data.byteLength;
    }
    const arr = new THREE.CompressedArrayTexture(mipmaps as never, f.mipmaps[0].width, f.mipmaps[0].height, c.length, f.format, f.type);
    arr.generateMipmaps = false;
    textures.account(bytes);
    return arr;
  }

  /** Fallback: decode every layer into one RGBA8 array (rows flipped to match flipY textures), GPU mipmaps. */
  private rgbaArray(texs: THREE.Texture[]) {
    const size = Math.min(1024, ...texs.map(t => (t.image as { width: number }).width || 512));
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const g = canvas.getContext('2d', { willReadFrequently: true })!;
    const data = new Uint8Array(size * size * 4 * texs.length);
    texs.forEach((t, i) => {
      g.clearRect(0, 0, size, size);
      g.save(); g.translate(0, size); g.scale(1, -1); // flip: array textures cannot flipY on upload
      g.drawImage(t.image as CanvasImageSource, 0, 0, size, size);
      g.restore();
      data.set(g.getImageData(0, 0, size, size).data, i * size * size * 4);
    });
    const arr = new THREE.DataArrayTexture(data, size, size, texs.length);
    arr.generateMipmaps = true;
    textures.account(data.byteLength * 1.333);
    return arr;
  }

  /** GLSL for the terrain shader (classic WebGL path). */
  static shader(quality: number) {
    const n = quality === 0 ? 2 : 4;
    return {
      defines: `#define SPLAT_N ${n}\n#define SPLAT_Q ${quality}\n#define ROCK_L ${LAYER.rock}\n`,
      vertexHead: `attribute vec4 splatW;\nattribute vec4 splatIds;\nattribute float tint;\nvarying vec4 vSplatW;\nflat varying vec4 vSplatIds;\nvarying float vTint;\nvarying vec3 vTerrPos;\nvarying vec3 vTerrN;\n`,
      // world metres from the tile UVs (continuous, wrapped every 6 km), height from the position
      vertexBody: `vSplatW = splatW; vSplatIds = splatIds; vTint = tint; vTerrPos = vec3(uv.x * 6.0, position.y, uv.y * 6.0); vTerrN = normal;\n`,
      fragmentHead: `uniform highp sampler2DArray uSplat;\nuniform float uSplatReady;\nuniform float uLayerScale[${LAYER_COUNT}];\nuniform float uLayerRot[${LAYER_COUNT}];\nvarying vec4 vSplatW;\nflat varying vec4 vSplatIds;\nvarying float vTint;\nvarying vec3 vTerrPos;\nvarying vec3 vTerrN;\n`,
      /**
       * Blend the tile's layers by weight, with a height-based edge (the
       * brighter, raised parts of a layer win where layers meet: stones show
       * through thin grass); High adds a rotated, larger-scale second sample
       * mixed by low-frequency noise; steep ground turns to rock, triplanar on
       * Medium/High so cliffs never stretch.
       */
      splat: `
  vec3 acc = vec3(0.0); float wsum = 0.0;
  for (int i = 0; i < SPLAT_N; i++) {
    float wi = vSplatW[i];
    if (wi < 0.01) continue;
    int L = int(vSplatIds[i] + 0.5);
    vec2 tuv = vTerrPos.xz * uLayerScale[L];
    vec3 c = texture(uSplat, vec3(tuv, float(L))).rgb;
    #if SPLAT_Q >= 2
      vec2 uv2 = tuv * 0.27;
      if (uLayerRot[L] > 0.5) uv2 = mat2(0.799, -0.602, 0.602, 0.799) * uv2;
      vec3 c2 = texture(uSplat, vec3(uv2 + vec2(0.37, 0.71), float(L))).rgb;
      float nm = rbNoise(vTerrPos.xz * 0.012) * 0.65 + rbNoise(vTerrPos.xz * 0.035 + 3.1) * 0.35;
      c = mix(c, c2, smoothstep(0.36, 0.64, nm) * 0.85);
    #endif
    float hgt = dot(c, vec3(0.299, 0.587, 0.114));
    float w = wi * (0.35 + hgt * 1.3);
    w *= w;
    acc += c * w; wsum += w;
  }
  vec3 ground = acc / max(wsum, 1e-5);
  vec3 tn = normalize(vTerrN);
  float rockW = smoothstep(0.22, 0.40, 1.0 - tn.y);
  if (rockW > 0.01) {
    float rs = uLayerScale[ROCK_L];
    #if SPLAT_Q >= 1
      vec3 bw = pow(abs(tn), vec3(4.0)); bw /= (bw.x + bw.y + bw.z);
      vec3 rock = texture(uSplat, vec3(vTerrPos.zy * rs, float(ROCK_L))).rgb * bw.x
                + texture(uSplat, vec3(vTerrPos.xz * rs, float(ROCK_L))).rgb * bw.y
                + texture(uSplat, vec3(vTerrPos.xy * rs, float(ROCK_L))).rgb * bw.z;
    #else
      vec3 rock = texture(uSplat, vec3(vTerrPos.xz * rs, float(ROCK_L))).rgb;
    #endif
    ground = mix(ground, rock, rockW);
  }
  diffuseColor.rgb *= ground * vTint;
`,
    };
  }

  /** Antialiasing is fixed per run; exposed for the material's program cache key. */
  static cacheKey(quality: number) { return `terrain-splat-${quality}-${effective().antialias ? 1 : 0}`; }
}
