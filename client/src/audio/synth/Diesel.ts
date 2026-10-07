import type { AudioEngine } from '../AudioEngine';

/**
 * Diesel engine voice (synthesised): the firing note of a 16-cylinder
 * four-stroke (rpm / 60 x cylinders / 2 Hz) through a low-pass "exhaust",
 * a half-order sub-harmonic for the idle lope, brown-noise rumble, a turbo
 * whistle that spools up with load (lagging like the turbo itself) and a
 * starter-motor whine while cranking.
 */
export class DieselVoice {
  private fire: OscillatorNode;
  private sub: OscillatorNode;
  private engine: GainNode;
  private exhaust: BiquadFilterNode;
  private rumble: GainNode;
  private turbo: OscillatorNode;
  private turboGain: GainNode;
  private starter: OscillatorNode;
  private starterGain: GainNode;
  private spool = 0;

  constructor(private a: AudioEngine, out: AudioNode, private cylinders: number) {
    const c = a.ctx;
    this.engine = c.createGain(); this.engine.gain.value = 0;
    this.exhaust = c.createBiquadFilter(); this.exhaust.type = 'lowpass'; this.exhaust.frequency.value = 320; this.exhaust.Q.value = 1.2;
    this.fire = c.createOscillator(); this.fire.type = 'sawtooth'; this.fire.frequency.value = 50;
    this.sub = c.createOscillator(); this.sub.type = 'triangle'; this.sub.frequency.value = 25;
    const subG = c.createGain(); subG.gain.value = 0.6;
    this.fire.connect(this.exhaust);
    this.sub.connect(subG).connect(this.exhaust);
    this.exhaust.connect(this.engine).connect(out);
    this.fire.start(); this.sub.start();
    // mechanical rumble
    const n = a.noiseSource('brown');
    const nf = c.createBiquadFilter(); nf.type = 'lowpass'; nf.frequency.value = 180;
    this.rumble = c.createGain(); this.rumble.gain.value = 0;
    n.connect(nf).connect(this.rumble).connect(out);
    // turbocharger whistle
    this.turbo = c.createOscillator(); this.turbo.type = 'sine'; this.turbo.frequency.value = 1800;
    this.turboGain = c.createGain(); this.turboGain.gain.value = 0;
    this.turbo.connect(this.turboGain).connect(out);
    this.turbo.start();
    // starter motor
    this.starter = c.createOscillator(); this.starter.type = 'square'; this.starter.frequency.value = 90;
    const sf = c.createBiquadFilter(); sf.type = 'bandpass'; sf.frequency.value = 700; sf.Q.value = 2;
    this.starterGain = c.createGain(); this.starterGain.gain.value = 0;
    this.starter.connect(sf).connect(this.starterGain).connect(out);
    this.starter.start();
  }

  /** rpm: crankshaft speed; load 0..1 (power developed / max); cranking: starter engaged. */
  update(dt: number, rpm: number, load: number, cranking: boolean) {
    const t = this.a.now;
    const firing = (rpm / 60) * (this.cylinders / 2);
    this.fire.frequency.setTargetAtTime(Math.max(8, firing), t, 0.08);
    this.sub.frequency.setTargetAtTime(Math.max(4, firing / 2), t, 0.08);
    this.exhaust.frequency.setTargetAtTime(260 + load * 420 + rpm * 0.15, t, 0.2);
    const running = rpm > 150;
    this.engine.gain.setTargetAtTime(running ? 0.16 + load * 0.22 : rpm > 20 ? 0.08 : 0, t, 0.15);
    this.rumble.gain.setTargetAtTime(rpm > 20 ? 0.18 + load * 0.25 : 0, t, 0.2);
    // the turbo spools up over a couple of seconds (its own lag), whistles with load
    this.spool += (load - this.spool) * Math.min(1, dt / 1.6);
    this.turbo.frequency.setTargetAtTime(1500 + this.spool * 3200, t, 0.3);
    this.turboGain.gain.setTargetAtTime(running ? 0.004 + this.spool * 0.035 : 0, t, 0.3);
    this.starter.frequency.setTargetAtTime(60 + rpm * 0.4, t, 0.2);
    this.starterGain.gain.setTargetAtTime(cranking ? 0.07 : 0, t, 0.05);
  }
}
