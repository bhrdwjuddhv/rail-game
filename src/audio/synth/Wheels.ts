import type { AudioEngine } from '../AudioEngine';

/** Continuous rolling rumble, flange squeal, bridge/tunnel colouring, slip and brake noise. */
export class RollingVoice {
  private rumble: GainNode;
  private rumbleF: BiquadFilterNode;
  private hollow: GainNode;
  private squeal: GainNode;
  private squealOsc: OscillatorNode;
  private slip: GainNode;
  private hiss: GainNode;
  private brakeSqueal: GainNode;
  private brakeOsc: OscillatorNode;
  private wind: GainNode;
  private t = 0;

  constructor(private a: AudioEngine, out: AudioNode, buffer: AudioBuffer | null) {
    const c = a.ctx;
    let src: AudioNode;
    if (buffer) { const s = c.createBufferSource(); s.buffer = buffer; s.loop = true; s.start(); src = s; }
    else src = a.noiseSource('brown');
    this.rumbleF = c.createBiquadFilter(); this.rumbleF.type = 'lowpass'; this.rumbleF.frequency.value = 200;
    this.rumble = c.createGain(); this.rumble.gain.value = 0;
    src.connect(this.rumbleF).connect(this.rumble).connect(out);
    // hollow steel-bridge resonance
    const hn = a.noiseSource('brown');
    const hf = c.createBiquadFilter(); hf.type = 'bandpass'; hf.frequency.value = 140; hf.Q.value = 4;
    this.hollow = c.createGain(); this.hollow.gain.value = 0;
    hn.connect(hf).connect(this.hollow).connect(out);
    // flange squeal
    this.squealOsc = c.createOscillator(); this.squealOsc.frequency.value = 3100;
    const vib = c.createOscillator(); vib.frequency.value = 5.3;
    const vibG = c.createGain(); vibG.gain.value = 60;
    vib.connect(vibG).connect(this.squealOsc.frequency); vib.start();
    this.squeal = c.createGain(); this.squeal.gain.value = 0;
    this.squealOsc.connect(this.squeal).connect(out); this.squealOsc.start();
    // wheel slip: rough low saw + noise
    const so = c.createOscillator(); so.type = 'sawtooth'; so.frequency.value = 75;
    const sf = c.createBiquadFilter(); sf.type = 'lowpass'; sf.frequency.value = 900;
    this.slip = c.createGain(); this.slip.gain.value = 0;
    so.connect(sf).connect(this.slip).connect(out); so.start();
    // air brake exhaust hiss
    const wn = a.noiseSource('white');
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2800;
    this.hiss = c.createGain(); this.hiss.gain.value = 0;
    wn.connect(hp).connect(this.hiss).connect(out);
    // brake block squeal at low speed
    this.brakeOsc = c.createOscillator(); this.brakeOsc.type = 'triangle'; this.brakeOsc.frequency.value = 3400;
    this.brakeSqueal = c.createGain(); this.brakeSqueal.gain.value = 0;
    this.brakeOsc.connect(this.brakeSqueal).connect(out); this.brakeOsc.start();
    // rushing air past the cab
    const an = a.noiseSource('white');
    const af = c.createBiquadFilter(); af.type = 'bandpass'; af.frequency.value = 700; af.Q.value = 0.5;
    this.wind = c.createGain(); this.wind.gain.value = 0;
    an.connect(af).connect(this.wind).connect(out);
  }

  update(dt: number, kmph: number, curvature: number, onSteelBridge: boolean, inTunnel: boolean, slipping: boolean, bpRate: number, bc: number) {
    this.t += dt;
    const now = this.a.now;
    const v = Math.abs(kmph);
    this.rumbleF.frequency.setTargetAtTime(160 + v * 9 + (inTunnel ? 200 : 0), now, 0.2);
    this.rumble.gain.setTargetAtTime(Math.min(0.8, v / 90) * (inTunnel ? 1.8 : 1) * (onSteelBridge ? 1.3 : 1), now, 0.2);
    this.hollow.gain.setTargetAtTime(onSteelBridge ? Math.min(0.7, v / 60) : 0, now, 0.15);
    const tight = Math.abs(curvature) > 1 / 650;
    const sq = tight && v > 8 ? Math.min(0.06, (Math.abs(curvature) - 1 / 650) * 40) * (0.5 + 0.5 * Math.sin(this.t * 1.7)) : 0;
    this.squeal.gain.setTargetAtTime(sq, now, 0.3);
    this.squealOsc.frequency.setTargetAtTime(2900 + Math.sin(this.t * 0.9) * 300, now, 0.2);
    this.slip.gain.setTargetAtTime(slipping ? 0.12 : 0, now, 0.05);
    this.hiss.gain.setTargetAtTime(Math.min(0.25, Math.abs(bpRate) * 0.35), now, 0.05);
    this.brakeSqueal.gain.setTargetAtTime(bc > 0.6 && v > 0.5 && v < 18 ? 0.035 * (1 - v / 18) : 0, now, 0.15);
    this.wind.gain.setTargetAtTime(Math.min(0.12, (v / 120) ** 2 * 0.12) * (inTunnel ? 2 : 1), now, 0.3);
  }
}
