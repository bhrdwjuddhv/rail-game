import * as THREE from 'three/webgpu';
import { WebGLRenderer } from 'three';
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { Quality } from './Settings';
import { prof } from './Profiler';

/**
 * Three interchangeable renderers (PERF_LOG.md, step 3a):
 *  - 'webgl'     classic WebGLRenderer + EffectComposer bloom (fastest here: no per-object UBO writes)
 *  - 'webgpu'    WebGPURenderer on the WebGPU backend
 *  - 'webgpu-gl' WebGPURenderer forced onto its WebGL2 backend
 * Scene materials are plain three.js materials; the only shader customisation
 * (vegetation wind) has a GLSL and a TSL variant chosen via `renderFlags`.
 */
export type RendererKind = 'webgl' | 'webgpu' | 'webgpu-gl';
export const renderFlags = { classic: true };

/** The part of the renderer API the game uses; both renderer classes provide it. */
export interface AnyRenderer {
  domElement: HTMLCanvasElement;
  toneMapping: THREE.ToneMapping;
  toneMappingExposure: number;
  shadowMap: { enabled: boolean; type: THREE.ShadowMapType };
  info: any;
  setAnimationLoop(cb: ((t: number) => void) | null): void;
  setPixelRatio(r: number): void;
  getPixelRatio(): number;
  setSize(w: number, h: number, style?: boolean): void;
  compileAsync(scene: THREE.Object3D, camera: THREE.Camera): Promise<unknown>;
  render(scene: THREE.Object3D, camera: THREE.Camera): void;
}

export class RenderSystem {
  private bloomOn = true;
  private bloomStrength = 0.32;
  private scene?: THREE.Scene;
  private camera?: THREE.Camera;
  private pipeline?: THREE.RenderPipeline;
  private bloomNode?: ReturnType<typeof bloom>;
  private composer?: EffectComposer;
  private bloomPass?: UnrealBloomPass;
  private maxPixelRatio = 1.5;
  /** smoothed GPU time per frame (ms) when timer queries are available */
  gpuMs = 0;
  /** GPU timer queries (EXT_disjoint_timer_query_webgl2) for real GPU frame time */
  private timer: { gl: WebGL2RenderingContext; ext: any; pending: WebGLQuery[] } | null = null;

  private constructor(readonly renderer: AnyRenderer, readonly kind: RendererKind, readonly backend: string) {}
  get label() { return this.kind === 'webgl' ? 'WebGLRenderer' : `WebGPURenderer/${this.backend}`; }

  static async create(container: HTMLElement, antialias: boolean, kind: RendererKind) {
    if (kind === 'webgpu' && !('gpu' in navigator)) kind = 'webgpu-gl';
    renderFlags.classic = kind === 'webgl';
    let renderer: AnyRenderer, backend: string;
    if (kind === 'webgl') {
      const r = new WebGLRenderer({ antialias, powerPreference: 'high-performance' });
      r.info.autoReset = false; // composer renders several passes; reset once per frame
      renderer = r as unknown as AnyRenderer;
      backend = 'WebGL2';
    } else {
      const r = new THREE.WebGPURenderer({ antialias, forceWebGL: kind === 'webgpu-gl', powerPreference: 'high-performance' });
      await r.init();
      backend = (r.backend as any).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
      renderer = r as unknown as AnyRenderer;
    }
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.id = 'game-canvas';
    container.appendChild(renderer.domElement);
    return new RenderSystem(renderer, kind, backend);
  }

  setScene(scene: THREE.Scene, camera: THREE.Camera) {
    this.scene = scene;
    this.camera = camera;
    if (this.kind === 'webgl') {
      const r = this.renderer as unknown as WebGLRenderer;
      this.composer = new EffectComposer(r);
      this.composer.addPass(new RenderPass(scene, camera));
      const size = r.getSize(new THREE.Vector2());
      // bloom at half resolution: it is blurry anyway
      this.bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), this.bloomStrength, 0.45, 0.82);
      this.composer.addPass(this.bloomPass);
      this.composer.addPass(new OutputPass());
    } else {
      this.pipeline = new THREE.RenderPipeline(this.renderer as unknown as THREE.WebGPURenderer);
      const scenePass = pass(scene, camera);
      const color = scenePass.getTextureNode('output');
      this.bloomNode = bloom(color, this.bloomStrength, 0.45, 0.82);
      this.pipeline.outputNode = color.add(this.bloomNode);
    }
  }

  setBloom(on: boolean, strength = 0.32) {
    this.bloomOn = on;
    this.bloomStrength = strength;
    if (this.bloomNode) this.bloomNode.strength.value = strength;
    if (this.bloomPass) this.bloomPass.strength = strength;
  }

  setMaxPixelRatio(r: number) { this.maxPixelRatio = r; }
  setRenderScale(scale: number) {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.maxPixelRatio) * scale);
    this.resizeComposer();
  }

  resize(w: number, h: number) {
    this.renderer.setSize(w, h, false);
    this.resizeComposer();
  }

  private resizeComposer() {
    if (!this.composer) return;
    const r = this.renderer as unknown as WebGLRenderer;
    const s = r.getSize(new THREE.Vector2());
    this.composer.setPixelRatio(r.getPixelRatio());
    this.composer.setSize(s.x, s.y);
    this.bloomPass?.resolution.set(s.x * r.getPixelRatio() / 2, s.y * r.getPixelRatio() / 2);
  }

  render() {
    if (!this.scene || !this.camera) return;
    if (this.kind === 'webgl') {
      (this.renderer.info as { reset(): void }).reset();
      const q = this.beginGpuTimer();
      if (this.bloomOn && this.composer) this.composer.render();
      else this.renderer.render(this.scene, this.camera);
      this.endGpuTimer(q);
      return;
    }
    if (this.bloomOn && this.pipeline) this.pipeline.render();
    else this.renderer.render(this.scene, this.camera);
  }

  private beginGpuTimer() {
    if (this.timer === null) {
      const gl = (this.renderer as unknown as WebGLRenderer).getContext() as WebGL2RenderingContext;
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      this.timer = ext ? { gl, ext, pending: [] } : (false as any);
    }
    const t = this.timer as any;
    if (!t || t.pending.length > 4) return null;
    const q = t.gl.createQuery();
    t.gl.beginQuery(t.ext.TIME_ELAPSED_EXT, q);
    return q as WebGLQuery;
  }

  private endGpuTimer(q: WebGLQuery | null) {
    const t = this.timer;
    if (!t) return;
    if (q) { t.gl.endQuery(t.ext.TIME_ELAPSED_EXT); t.pending.push(q); }
    while (t.pending.length && t.gl.getQueryParameter(t.pending[0], t.gl.QUERY_RESULT_AVAILABLE)) {
      const done = t.pending.shift()!;
      if (!t.gl.getParameter(t.ext.GPU_DISJOINT_EXT)) {
        const ms = t.gl.getQueryParameter(done, t.gl.QUERY_RESULT) / 1e6;
        this.gpuMs = this.gpuMs ? this.gpuMs * 0.9 + ms * 0.1 : ms;
        prof.counters.gpu = this.gpuMs;
      }
      t.gl.deleteQuery(done);
    }
  }

  /** Rough GPU class from the adapter / unmasked renderer string. */
  detectQuality(): Quality {
    let name = '';
    try {
      const gl: WebGL2RenderingContext | undefined = this.kind === 'webgl'
        ? (this.renderer as unknown as WebGLRenderer).getContext() as WebGL2RenderingContext
        : (this.renderer as any).backend?.gl;
      if (gl) {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      } else {
        const info = (this.renderer as any).backend?.adapter?.info;
        name = `${info?.vendor ?? ''} ${info?.architecture ?? ''} ${info?.description ?? ''}`;
      }
    } catch { /* privacy-restricted browsers */ }
    name = name.toLowerCase();
    if (/swiftshader|llvmpipe|software|microsoft basic/.test(name)) return 'low';
    if (/intel|mali|adreno|powervr|uhd|iris/.test(name)) return 'medium';
    if (/rtx\s*[2-9]0[7-9]0|rtx\s*[3-9]0[89]0|rx\s*[67]9|apple m[2-9] (pro|max|ultra)/.test(name)) return 'ultra';
    return 'high';
  }

  stats() {
    const i = this.renderer.info;
    const calls = this.kind === 'webgl' ? i.render.calls : i.render.drawCalls;
    return { drawCalls: calls as number, triangles: i.render.triangles as number, geometries: i.memory.geometries as number, textures: i.memory.textures as number };
  }
}
