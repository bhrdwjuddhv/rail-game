import { prof } from './Profiler';
import type { RenderSystem } from './Renderer';

export type BenchView = 'cab' | 'chase' | 'free';
export interface BenchConfig { view: BenchView; seconds: number; warmup: number; speedKmph: number }

export interface BenchResult {
  view: BenchView; renderer: string; seconds: number; frames: number;
  avgFps: number; low1Fps: number; worstMs: number; over33: number; over50: number;
  drawCalls: number; triangles: number; geometriesStart: number; geometriesEnd: number; texturesEnd: number;
  heapStartMB: number; heapEndMB: number; sections: Record<string, number>; userAgent: string;
}

/**
 * Repeatable run: fixed start, fixed speed, fixed camera, fixed weather/time.
 * Collects every frame time after a warm-up and publishes the result on
 * window.__rail.bench (read by the automated runner).
 */
export class Benchmark {
  private t = 0;
  private frames: number[] = [];
  private calls = 0;
  private tris = 0;
  private geoStart = 0;
  private heapStart = 0;
  done = false;

  constructor(readonly cfg: BenchConfig, private rs: RenderSystem) {}

  frame(dtMs: number) {
    if (this.done) return;
    this.t += dtMs / 1000;
    if (this.t < this.cfg.warmup) return;
    const s = this.rs.stats();
    if (!this.frames.length) { this.geoStart = s.geometries; this.heapStart = heap(); }
    this.frames.push(dtMs);
    this.calls += s.drawCalls;
    this.tris += s.triangles;
    if (this.t < this.cfg.warmup + this.cfg.seconds) return;
    this.done = true;
    const n = this.frames.length;
    const sorted = [...this.frames].sort((a, b) => b - a);
    const k = Math.max(1, Math.floor(n / 100));
    const mean = this.frames.reduce((a, b) => a + b, 0) / n;
    const result: BenchResult = {
      view: this.cfg.view, renderer: this.rs.label, seconds: this.cfg.seconds, frames: n,
      avgFps: round(1000 / mean), low1Fps: round(1000 / (sorted.slice(0, k).reduce((a, b) => a + b, 0) / k)),
      worstMs: round(sorted[0]), over33: this.frames.filter(f => f > 33.4).length, over50: this.frames.filter(f => f > 50).length,
      drawCalls: Math.round(this.calls / n), triangles: Math.round(this.tris / n),
      geometriesStart: this.geoStart, geometriesEnd: s.geometries, texturesEnd: s.textures,
      heapStartMB: round(this.heapStart), heapEndMB: round(heap()),
      sections: { ...Object.fromEntries([...prof.avg.entries()].map(([k2, v]) => [k2, round(v, 2)])), gpu: round(prof.counters.gpu ?? 0, 2) },
      userAgent: navigator.userAgent,
    };
    (window as any).__rail.bench = result;
    console.log('BENCH', JSON.stringify(result));
  }
}

const heap = () => ((performance as any).memory?.usedJSHeapSize ?? 0) / 1048576;
const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
