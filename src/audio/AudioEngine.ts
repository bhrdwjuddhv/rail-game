import { makeImpulse, makeNoise } from './synth/Noise';

export type Bus = 'train' | 'horn' | 'env' | 'ui';

/**
 * Web Audio mixer: per-category buses -> master, an "exterior" low-pass that
 * muffles outside sounds while in the cab, and a convolution reverb send used
 * for tunnels and ghat echoes.
 */
export class AudioEngine {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly buses: Record<Bus, GainNode>;
  /** outside-world sounds go through this (muffled in the cab) */
  readonly exterior: BiquadFilterNode;
  readonly exteriorGain: GainNode;
  readonly reverbSend: GainNode;
  readonly white: AudioBuffer;
  readonly brown: AudioBuffer;
  private reverb: ConvolverNode;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    const c = this.ctx;
    this.master = c.createGain();
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -12; comp.ratio.value = 6;
    this.master.connect(comp).connect(c.destination);
    this.buses = { train: c.createGain(), horn: c.createGain(), env: c.createGain(), ui: c.createGain() };
    this.exterior = c.createBiquadFilter();
    this.exterior.type = 'lowpass';
    this.exterior.frequency.value = 20000;
    this.exteriorGain = c.createGain();
    this.exterior.connect(this.exteriorGain).connect(this.master);
    for (const k of ['train', 'horn', 'env'] as Bus[]) this.buses[k].connect(this.exterior);
    this.buses.ui.connect(this.master);
    this.white = makeNoise(c, 'white');
    this.brown = makeNoise(c, 'brown');
    this.reverb = c.createConvolver();
    this.reverb.buffer = makeImpulse(c, 2.6, 2.2);
    this.reverbSend = c.createGain();
    this.reverbSend.gain.value = 0.08;
    this.reverbSend.connect(this.reverb).connect(this.exterior);
  }

  resume() { if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {}); }

  private suspendTimer = 0;
  /** Pause: fade everything down, then suspend the context (no CPU spent on audio while paused). */
  fadeOut() {
    this.master.gain.cancelScheduledValues(this.now);
    this.master.gain.setTargetAtTime(0, this.now, 0.08);
    clearTimeout(this.suspendTimer);
    this.suspendTimer = window.setTimeout(() => this.ctx.suspend().catch(() => {}), 450);
  }
  fadeIn(volume: number) {
    clearTimeout(this.suspendTimer);
    this.resume();
    this.master.gain.cancelScheduledValues(this.now);
    this.master.gain.setTargetAtTime(volume, this.now, 0.12);
  }
  get now() { return this.ctx.currentTime; }

  setVolumes(v: { master: number; train: number; horn: number; env: number; ui: number }) {
    const t = this.now;
    this.master.gain.setTargetAtTime(v.master, t, 0.05);
    this.buses.train.gain.setTargetAtTime(v.train, t, 0.05);
    this.buses.horn.gain.setTargetAtTime(v.horn, t, 0.05);
    this.buses.env.gain.setTargetAtTime(v.env, t, 0.05);
    this.buses.ui.gain.setTargetAtTime(v.ui, t, 0.05);
  }

  /** In the cab the outside world is muffled and a bit quieter. */
  setCab(inCab: boolean) {
    this.exterior.frequency.setTargetAtTime(inCab ? 2600 : 20000, this.now, 0.2);
    this.exteriorGain.gain.setTargetAtTime(inCab ? 0.75 : 1, this.now, 0.2);
  }

  setReverb(amount: number) { this.reverbSend.gain.setTargetAtTime(amount, this.now, 0.3); }

  setListener(px: number, py: number, pz: number, fx: number, fy: number, fz: number) {
    const l = this.ctx.listener;
    if (l.positionX) {
      const t = this.now;
      l.positionX.setTargetAtTime(px, t, 0.02); l.positionY.setTargetAtTime(py, t, 0.02); l.positionZ.setTargetAtTime(pz, t, 0.02);
      l.forwardX.setTargetAtTime(fx, t, 0.02); l.forwardY.setTargetAtTime(fy, t, 0.02); l.forwardZ.setTargetAtTime(fz, t, 0.02);
      l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    } else {
      (l as any).setPosition(px, py, pz);
      (l as any).setOrientation(fx, fy, fz, 0, 1, 0);
    }
  }

  /** A panner feeding a bus (and optionally the reverb). */
  panner(bus: Bus, refDistance = 8, rolloff = 1) {
    const p = this.ctx.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = refDistance;
    p.rolloffFactor = rolloff;
    p.maxDistance = 5000;
    p.connect(this.buses[bus]);
    return p;
  }

  setPannerPos(p: PannerNode, x: number, y: number, z: number) {
    if (p.positionX) { p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z; }
    else (p as any).setPosition(x, y, z);
  }

  noiseSource(type: 'white' | 'brown' = 'white') {
    const s = this.ctx.createBufferSource();
    s.buffer = type === 'white' ? this.white : this.brown;
    s.loop = true;
    s.loopStart = Math.random();
    s.start(this.now, Math.random());
    return s;
  }
}
