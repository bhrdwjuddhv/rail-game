import type { AudioEngine } from '../AudioEngine';

/**
 * Two-tone electric loco horn (original synthesis): each tone is a detuned
 * chord of sawtooth "reeds" through a horn-bell formant filter with a soft
 * attack, plus a send to the reverb for echoes in tunnels and ghats.
 */
export class HornVoice {
  private gain: GainNode;
  private oscs: OscillatorNode[] = [];
  private base: number[] = [];
  private file: AudioBufferSourceNode | null = null;

  constructor(private a: AudioEngine, freqs: number[], out: AudioNode, buffer: AudioBuffer | null) {
    const c = a.ctx;
    this.gain = c.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(out);
    this.gain.connect(a.reverbSend);
    if (buffer) {
      this.file = c.createBufferSource();
      this.file.buffer = buffer; this.file.loop = true;
      this.file.connect(this.gain);
      this.file.start();
      return;
    }
    const shaper = c.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; curve[i] = Math.tanh(x * 2.2); }
    shaper.curve = curve;
    const bell = c.createBiquadFilter();
    bell.type = 'peaking'; bell.frequency.value = 1400; bell.Q.value = 1.2; bell.gain.value = 7;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 3800;
    const mix = c.createGain();
    mix.gain.value = 0.11;
    mix.connect(shaper).connect(bell).connect(lp).connect(this.gain);
    for (const f of freqs) for (const det of [-6, 0, 7]) {
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = det;
      this.base.push(det);
      o.connect(mix);
      o.start();
      this.oscs.push(o);
    }
  }

  set(on: boolean) {
    const t = this.a.now;
    this.gain.gain.cancelScheduledValues(t);
    this.gain.gain.setTargetAtTime(on ? 0.9 : 0, t, on ? 0.035 : 0.09);
    // slight pitch sag on attack like a real air horn
    this.oscs.forEach((o, i) => {
      o.detune.cancelScheduledValues(t);
      if (on) { o.detune.setValueAtTime(this.base[i] - 35, t); o.detune.setTargetAtTime(this.base[i], t, 0.08); }
    });
  }
}
