import type { AudioEngine } from '../AudioEngine';

/** Traction motor whine + gear mesh, transformer hum, blowers and compressor. */
export class MotorVoice {
  private whine: OscillatorNode[] = [];
  private whineGain: GainNode;
  private gear: OscillatorNode;
  private gearGain: GainNode;
  private hum: GainNode;
  private blower: GainNode;
  private comp: GainNode;
  private compLfo: OscillatorNode;
  private file: AudioBufferSourceNode | null = null;

  constructor(private a: AudioEngine, out: AudioNode, buffer: AudioBuffer | null) {
    const c = a.ctx;
    this.whineGain = c.createGain(); this.whineGain.gain.value = 0;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 3;
    bp.frequency.value = 900;
    this.whineGain.connect(out);
    if (buffer) {
      this.file = c.createBufferSource(); this.file.buffer = buffer; this.file.loop = true;
      this.file.connect(this.whineGain); this.file.start();
    } else {
      for (const [type, mul, g] of [['square', 1, 0.05], ['sine', 2, 0.25], ['triangle', 3.01, 0.12]] as const) {
        const o = c.createOscillator(); o.type = type; o.frequency.value = 40 * mul;
        const og = c.createGain(); og.gain.value = g;
        o.connect(og).connect(this.whineGain);
        o.start();
        (o as any).mul = mul;
        this.whine.push(o);
      }
    }
    this.gear = c.createOscillator(); this.gear.type = 'sawtooth';
    const gearF = c.createBiquadFilter(); gearF.type = 'bandpass'; gearF.Q.value = 6; gearF.frequency.value = 1500;
    this.gearGain = c.createGain(); this.gearGain.gain.value = 0;
    this.gear.connect(gearF).connect(this.gearGain).connect(out);
    this.gear.start();
    // transformer hum (2x 50 Hz) when the VCB is closed
    const h = c.createOscillator(); h.frequency.value = 100;
    const h2 = c.createOscillator(); h2.frequency.value = 200;
    this.hum = c.createGain(); this.hum.gain.value = 0;
    const h2g = c.createGain(); h2g.gain.value = 0.3;
    h.connect(this.hum); h2.connect(h2g).connect(this.hum); this.hum.connect(out);
    h.start(); h2.start();
    // blowers: band-passed noise
    const bn = a.noiseSource('white');
    const bf = c.createBiquadFilter(); bf.type = 'bandpass'; bf.frequency.value = 520; bf.Q.value = 0.7;
    this.blower = c.createGain(); this.blower.gain.value = 0;
    bn.connect(bf).connect(this.blower).connect(out);
    // compressor: low thumping noise modulated at ~9 Hz
    const cn = a.noiseSource('brown');
    const cf = c.createBiquadFilter(); cf.type = 'lowpass'; cf.frequency.value = 260;
    const cm = c.createGain(); cm.gain.value = 0.5;
    this.compLfo = c.createOscillator(); this.compLfo.frequency.value = 9;
    const lfoG = c.createGain(); lfoG.gain.value = 0.5;
    this.compLfo.connect(lfoG).connect(cm.gain);
    this.compLfo.start();
    this.comp = c.createGain(); this.comp.gain.value = 0;
    cn.connect(cf).connect(cm).connect(this.comp).connect(out);
  }

  update(speedKmph: number, amps: number, vcb: boolean, compressor: boolean, hzBase: number, hzPerKmph: number) {
    const t = this.a.now;
    const f = hzBase + Math.abs(speedKmph) * hzPerKmph;
    for (const o of this.whine) o.frequency.setTargetAtTime(f * (o as any).mul, t, 0.05);
    if (this.file) this.file.playbackRate.setTargetAtTime(0.4 + Math.abs(speedKmph) / 80, t, 0.1);
    const load = Math.min(1, amps / 1000);
    this.whineGain.gain.setTargetAtTime(vcb ? 0.05 + load * 0.35 * Math.min(1, Math.abs(speedKmph) / 6 + 0.3) : 0, t, 0.08);
    this.gear.frequency.setTargetAtTime(f * 4.3, t, 0.05);
    this.gearGain.gain.setTargetAtTime(Math.min(0.08, Math.abs(speedKmph) / 900) * (0.4 + load), t, 0.1);
    this.hum.gain.setTargetAtTime(vcb ? 0.035 + load * 0.03 : 0, t, 0.2);
    this.blower.gain.setTargetAtTime(vcb ? 0.07 + load * 0.08 : 0, t, 0.6);
    this.comp.gain.setTargetAtTime(compressor ? 0.25 : 0, t, 0.3);
  }
}
