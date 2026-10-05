// Lightweight CPU section timers + frame-time statistics for the F3 overlay and the benchmark.

const N = 600; // rolling window of frames

class Profiler {
  private start = new Map<string, number>();
  private acc = new Map<string, number>();
  /** smoothed ms per frame for each section */
  readonly avg = new Map<string, number>();
  readonly frameMs = new Float32Array(N);
  private i = 0;
  private filled = 0;
  counters: Record<string, number> = {};

  begin(name: string) { this.start.set(name, performance.now()); }
  end(name: string) {
    const s = this.start.get(name);
    if (s === undefined) return;
    this.acc.set(name, (this.acc.get(name) ?? 0) + performance.now() - s);
  }
  /** Add an externally measured duration (e.g. GPU timer query) to a section. */
  add(name: string, ms: number) { this.acc.set(name, (this.acc.get(name) ?? 0) + ms); }
  /** Time a function call into a section. */
  time<T>(name: string, fn: () => T): T {
    const s = performance.now();
    try { return fn(); } finally { this.acc.set(name, (this.acc.get(name) ?? 0) + performance.now() - s); }
  }

  /** Call once per rendered frame with that frame's wall time in ms. */
  frame(ms: number) {
    this.frameMs[this.i] = ms;
    this.i = (this.i + 1) % N;
    this.filled = Math.min(N, this.filled + 1);
    for (const [k, v] of this.acc) this.avg.set(k, (this.avg.get(k) ?? v) * 0.95 + v * 0.05);
    this.acc.clear();
  }

  /** avg FPS, 1% low FPS (mean of the worst 1% frames), worst frame ms over the window. */
  stats() {
    const n = this.filled;
    if (!n) return { fps: 0, low1: 0, worst: 0, avgMs: 0 };
    const a = Array.from(this.frameMs.subarray(0, n)).sort((x, y) => y - x);
    const k = Math.max(1, Math.floor(n / 100));
    const worst1 = a.slice(0, k).reduce((s, v) => s + v, 0) / k;
    const mean = a.reduce((s, v) => s + v, 0) / n;
    return { fps: 1000 / mean, low1: 1000 / worst1, worst: a[0], avgMs: mean };
  }
}

export const prof = new Profiler();
