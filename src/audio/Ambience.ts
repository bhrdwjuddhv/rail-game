import type { AudioEngine } from './AudioEngine';
import type { OneShots } from './synth/OneShots';

/**
 * World ambience: rain (louder on the cab roof), wind, insects by day, crickets
 * at night, birds, river near water, crowd murmur near stations and level
 * crossing bells. Positional where it matters.
 */
export class Ambience {
  private rain: GainNode;
  private roof: GainNode;
  private wind: GainNode;
  private insects: GainNode;
  private river: GainNode;
  private riverPan: PannerNode;
  private crowd: GainNode;
  private crowdPan: PannerNode;
  private nextBird = 2;
  private nextCricket = 1;
  private bellTimers = new Map<number, number>();
  readonly bellPans = new Map<number, PannerNode>();

  constructor(private a: AudioEngine, private shots: OneShots) {
    const c = a.ctx, env = a.buses.env;
    const mk = (src: AudioNode, type: BiquadFilterType, f: number, q: number, dest: AudioNode) => {
      const fl = c.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
      const g = c.createGain(); g.gain.value = 0;
      src.connect(fl).connect(g).connect(dest);
      return g;
    };
    this.rain = mk(a.noiseSource('white'), 'lowpass', 6500, 0.4, env);
    // roof drumming bypasses the exterior muffle (it is *on* the cab)
    this.roof = mk(a.noiseSource('white'), 'bandpass', 1900, 0.7, a.master);
    this.wind = mk(a.noiseSource('brown'), 'bandpass', 380, 0.5, env);
    const ins = a.noiseSource('white');
    const am = c.createGain(); am.gain.value = 0.5;
    const lfo = c.createOscillator(); lfo.frequency.value = 31; const lg = c.createGain(); lg.gain.value = 0.5;
    lfo.connect(lg).connect(am.gain); lfo.start();
    ins.connect(am);
    this.insects = mk(am, 'bandpass', 6200, 3, env);
    this.riverPan = a.panner('env', 40, 1.2);
    this.river = mk(a.noiseSource('white'), 'bandpass', 900, 0.4, this.riverPan);
    this.crowdPan = a.panner('env', 25, 1.3);
    const babble = c.createGain(); babble.gain.value = 1;
    for (let i = 0; i < 4; i++) {
      const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 120 + i * 37;
      const f = c.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 5; f.frequency.value = 600 + i * 400;
      const vl = c.createOscillator(); vl.frequency.value = 2.1 + i * 0.7; const vg = c.createGain(); vg.gain.value = 300 + i * 120;
      vl.connect(vg).connect(f.frequency); vl.start();
      o.connect(f).connect(babble); o.start();
    }
    const bn = a.noiseSource('white'); const bf = c.createBiquadFilter(); bf.type = 'bandpass'; bf.frequency.value = 1500; bf.Q.value = 0.5;
    bn.connect(bf).connect(babble);
    this.crowd = c.createGain(); this.crowd.gain.value = 0;
    babble.connect(this.crowd).connect(this.crowdPan);
  }

  update(dt: number, s: {
    rain: number; wind: number; day: number; speed: number; inCab: boolean;
    river: { x: number; y: number; z: number; d: number } | null;
    station: { x: number; y: number; z: number; d: number } | null;
    bells: { id: number; x: number; y: number; z: number; ringing: boolean }[];
    cam: { x: number; y: number; z: number };
  }) {
    const t = this.a.now;
    this.rain.gain.setTargetAtTime(s.rain * 0.35, t, 0.5);
    this.roof.gain.setTargetAtTime(s.inCab ? s.rain * 0.18 : 0, t, 0.5);
    this.wind.gain.setTargetAtTime(Math.min(0.5, s.wind * 0.12), t, 0.8);
    this.insects.gain.setTargetAtTime(s.day > 0.5 && s.rain < 0.2 ? 0.035 : 0, t, 2);
    if (s.river) { this.a.setPannerPos(this.riverPan, s.river.x, s.river.y, s.river.z); this.river.gain.setTargetAtTime(s.river.d < 600 ? 0.5 : 0, t, 1); }
    else this.river.gain.setTargetAtTime(0, t, 1);
    if (s.station) { this.a.setPannerPos(this.crowdPan, s.station.x, s.station.y, s.station.z); this.crowd.gain.setTargetAtTime(s.station.d < 400 ? 0.035 : 0, t, 1); }
    else this.crowd.gain.setTargetAtTime(0, t, 1);

    // birds by day, crickets at night (one-shots scattered around the listener)
    this.nextBird -= dt; this.nextCricket -= dt;
    if (this.nextBird <= 0) {
      this.nextBird = 1.5 + Math.random() * 5;
      if (s.day > 0.4 && s.rain < 0.4) this.scattered(s.cam, p => this.shots.chirp(p, 0.1));
    }
    if (this.nextCricket <= 0) {
      this.nextCricket = 0.4 + Math.random() * 0.9;
      if (s.day < 0.3 && s.rain < 0.4) this.scattered(s.cam, p => this.shots.cricket(p, 0.04));
    }
    // level crossing bells (positional, repeating while ringing)
    for (const b of s.bells) {
      let pan = this.bellPans.get(b.id);
      if (!pan) { pan = this.a.panner('env', 20, 1.3); this.bellPans.set(b.id, pan); }
      this.a.setPannerPos(pan, b.x, b.y, b.z);
      if (!b.ringing) continue;
      const due = (this.bellTimers.get(b.id) ?? 0) - dt;
      if (due <= 0) { this.shots.bell(pan, this.a.now, 0.3); this.bellTimers.set(b.id, 0.5); }
      else this.bellTimers.set(b.id, due);
    }
  }

  private scattered(cam: { x: number; y: number; z: number }, play: (dest: AudioNode) => void) {
    const p = this.a.panner('env', 15, 1);
    const ang = Math.random() * Math.PI * 2, d = 20 + Math.random() * 80;
    this.a.setPannerPos(p, cam.x + Math.cos(ang) * d, cam.y + 5, cam.z + Math.sin(ang) * d);
    play(p);
    setTimeout(() => p.disconnect(), 2000);
  }
}
