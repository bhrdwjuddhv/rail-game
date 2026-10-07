import type { RenderSystem } from '../core/Renderer';
import { prof } from '../core/Profiler';
import { textures } from '../core/TextureLibrary';

/** F3 overlay: FPS, frame time + 1% worst, draw calls, triangles, memory, chunk and grass counts, section timers. */
export class PerfOverlay {
  readonly el = document.createElement('pre');
  visible = false;
  private acc = 0;

  constructor(parent: HTMLElement, private rs: RenderSystem) {
    this.el.className = 'perf';
    this.el.style.display = 'none';
    parent.appendChild(this.el);
  }

  toggle() { this.visible = !this.visible; this.el.style.display = this.visible ? '' : 'none'; }

  frame(dt: number) {
    this.acc += dt;
    if (this.acc < 0.5 || !this.visible) return;
    this.acc = 0;
    const s = this.rs.stats();
    const f = prof.stats();
    const mem = (performance as any).memory;
    const sec = [...prof.avg.entries()].map(([k, v]) => `${k} ${v.toFixed(2)}`).join('  ');
    const c = prof.counters;
    const src = textures.sourceCounts();
    this.el.textContent =
      `${this.rs.label}  ${f.fps.toFixed(0)} FPS  (1% low ${f.low1.toFixed(0)})\n` +
      `frame ${f.avgMs.toFixed(1)} ms  worst ${f.worst.toFixed(1)} ms  pixelRatio ${this.rs.renderer.getPixelRatio().toFixed(2)}\n` +
      `draw calls ${s.drawCalls}  tris ${(s.triangles / 1000).toFixed(0)}k\n` +
      `geometries ${s.geometries}  textures ${s.textures}` + (mem ? `  heap ${(mem.usedJSHeapSize / 1048576).toFixed(0)} MB` : '') + '\n' +
      `Textures: ${src.files} loaded from files / ${src.procedural} procedural fallback\n` +
      `file textures ${c.texCount ?? 0}  ${(c.texMB ?? 0).toFixed(1)} / ${c.texBudget ?? 0} MB${c.texQueued ? `  (${c.texQueued} loading)` : ''}\n` +
      `tiles ${c.tiles ?? 0}  track chunks ${c.trackChunks ?? 0}  grass ${c.grass ?? 0}  props ${c.props ?? 0}\n` +
      `ms: ${sec}\n` +
      `km ${(c.km ?? 0).toFixed(3)}  origin ${c.originX ?? 0},${c.originZ ?? 0}`;
  }
}
