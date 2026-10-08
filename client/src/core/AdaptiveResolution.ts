/**
 * Dynamic resolution (Settings > Adaptive resolution): when frames run slow,
 * render at a slightly lower resolution; when there is headroom, step back up
 * to the scale the settings ask for. A busy scene then stays smooth instead of
 * stuttering. It reacts to the GPU's frame time where the browser reports it
 * (lowering the resolution cannot help a frame that is slow on the CPU),
 * otherwise to the whole frame time. Small steps with a cooldown, so the
 * picture never visibly pumps.
 */
export class AdaptiveResolution {
  scale = 1;
  private avg = 16.7;
  private cool = 2;

  /** min: the lowest scale it may use */
  constructor(private min: number) {}

  /**
   * frameMs: this frame's wall time; gpuMs: GPU time (0 if unknown); max: the
   * settings' render scale; dt: seconds. Returns the scale to render at.
   */
  update(frameMs: number, gpuMs: number, max: number, dt: number) {
    if (frameMs < 250) this.avg += ((gpuMs > 0 ? gpuMs : frameMs) - this.avg) * 0.05;   // ignore one-off stalls (loading, teleport)
    this.cool -= dt;
    this.scale = Math.min(this.scale, max);
    if (this.cool > 0) return this.scale;
    if (this.avg > 1000 / 45 && this.scale > this.min + 1e-3) { this.scale = Math.max(this.min, this.scale - 0.05); this.cool = 1; }
    else if (this.avg < 1000 / 56 && this.scale < max - 1e-3) { this.scale = Math.min(max, this.scale + 0.05); this.cool = 2.5; }
    return this.scale;
  }
}
