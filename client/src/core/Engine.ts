// Fixed-step simulation decoupled from rendering.
import { prof } from './Profiler';

export class Engine {
  readonly step: number;
  paused = false;
  simTime = 0;
  private acc = 0;
  private last = -1;
  /** unclamped wall time of the last frame (ms), for profiling */
  rawMs = 0;
  /** called once if the simulation or a frame throws; the loop then stops ticking */
  onError?: (e: unknown) => void;
  private failed = false;

  constructor(
    private sim: (dt: number) => void,
    private frame: (dt: number, alpha: number) => void,
    hz = 120,
  ) {
    this.step = 1 / hz;
  }

  /** forget the last frame time (after the loop was stopped), so the next frame starts fresh */
  resetClock() { this.last = -1; }

  tick(nowMs: number) {
    if (this.failed) return;
    try { this.tickInner(nowMs); } catch (e) {
      this.failed = true;
      this.paused = true;
      console.error('[engine] stopped after an error:', e);
      this.onError?.(e);
    }
  }

  private tickInner(nowMs: number) {
    if (this.last < 0) this.last = nowMs;
    this.rawMs = nowMs - this.last;
    const dt = Math.min(0.1, this.rawMs / 1000);
    this.last = nowMs;
    if (!this.paused) {
      prof.begin('sim');
      this.acc += dt;
      let n = 0;
      while (this.acc >= this.step && n < 24) {
        this.sim(this.step);
        this.simTime += this.step;
        this.acc -= this.step;
        n++;
      }
      if (n === 24) this.acc = 0; // way behind: drop time rather than spiral
      prof.end('sim');
    }
    this.frame(dt, this.acc / this.step);
  }
}
