import type { AudioEngine } from '../AudioEngine';

/** Short synthesized events: clicks, clunks, clanks, wheel clacks, bells, chimes, PA voice, thunder, honks. */
export class OneShots {
  constructor(private a: AudioEngine) {}

  private env(dest: AudioNode, t: number, peak: number, attack: number, decay: number) {
    const g = this.a.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    g.connect(dest);
    return g;
  }

  private noiseBurst(dest: AudioNode, t: number, dur: number, type: BiquadFilterType, freq: number, q: number, peak: number, brown = false) {
    const c = this.a.ctx;
    const s = c.createBufferSource();
    s.buffer = brown ? this.a.brown : this.a.white;
    const f = c.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    s.connect(f).connect(this.env(dest, t, peak, 0.002, dur));
    s.start(t, Math.random() * 2);
    s.stop(t + dur + 0.05);
  }

  private tone(dest: AudioNode, t: number, freq: number, dur: number, peak: number, type: OscillatorType = 'sine', attack = 0.003) {
    const o = this.a.ctx.createOscillator();
    o.type = type; o.frequency.value = freq;
    o.connect(this.env(dest, t, peak, attack, dur));
    o.start(t); o.stop(t + attack + dur + 0.05);
    return o;
  }

  click(dest: AudioNode, vol = 0.3) { const t = this.a.now; this.noiseBurst(dest, t, 0.012, 'highpass', 2500, 0.7, vol); this.tone(dest, t, 2200, 0.01, vol * 0.3, 'square'); }
  clunk(dest: AudioNode, vol = 0.5) { const t = this.a.now; this.noiseBurst(dest, t, 0.06, 'lowpass', 700, 0.7, vol); this.tone(dest, t, 110, 0.08, vol * 0.8); }

  /** Coupler slack running in: a ripple of metallic clanks travelling down the train. */
  couplerRipple(dest: AudioNode, magnitude: number, count: number) {
    const t0 = this.a.now;
    for (let i = 0; i < count; i++) {
      const t = t0 + i * 0.11 + Math.random() * 0.03;
      const v = magnitude * 0.6 * Math.pow(0.82, i);
      for (const f of [180, 427, 911, 1530]) this.tone(dest, t, f * (0.97 + Math.random() * 0.06), 0.25, v * (f < 500 ? 0.6 : 0.25));
      this.noiseBurst(dest, t, 0.05, 'bandpass', 1200, 1, v * 0.5);
    }
  }

  /** One wheelset over a rail joint (pair of hits for the two axles of a bogie). */
  clack(dest: AudioNode, t: number, vol: number, bright: number) {
    this.noiseBurst(dest, t, 0.03, 'bandpass', 700 + bright * 700, 1.4, vol);
    this.tone(dest, t, 62, 0.06, vol * 0.9);
  }

  switchClatter(dest: AudioNode, speed: number, vol = 0.6) {
    const t0 = this.a.now, gap = 2.5 / Math.max(2, speed);
    for (let i = 0; i < 6; i++) this.clack(dest, t0 + i * gap * (0.6 + Math.random() * 0.8), vol * (0.6 + Math.random() * 0.4), 1);
  }

  beep(dest: AudioNode, vol = 0.2) { this.tone(dest, this.a.now, 1250, 0.12, vol, 'square'); }
  buzz(dest: AudioNode, vol = 0.18) { const t = this.a.now; this.tone(dest, t, 820, 0.35, vol, 'square'); this.tone(dest, t + 0.45, 820, 0.35, vol, 'square'); }

  /** Station PA: three-note chime then a band-limited, formant "voice" babble (no recordings). */
  announcement(dest: AudioNode, vol = 0.4) {
    const c = this.a.ctx, t0 = this.a.now;
    [659, 523, 392].forEach((f, i) => { this.tone(dest, t0 + i * 0.45, f, 1.2, vol * 0.5); this.tone(dest, t0 + i * 0.45, f * 2.76, 0.6, vol * 0.08); });
    const start = t0 + 1.8;
    const src = c.createOscillator(); src.type = 'sawtooth';
    const f1 = c.createBiquadFilter(); f1.type = 'bandpass'; f1.Q.value = 6;
    const f2 = c.createBiquadFilter(); f2.type = 'bandpass'; f2.Q.value = 8;
    const pa = c.createBiquadFilter(); pa.type = 'bandpass'; pa.frequency.value = 1400; pa.Q.value = 0.6;
    const g = c.createGain(); g.gain.value = 0;
    src.connect(f1).connect(pa); src.connect(f2).connect(pa); pa.connect(g).connect(dest);
    g.connect(this.a.reverbSend);
    const vowels = [[730, 1090], [270, 2290], [300, 870], [530, 1840], [640, 1190], [400, 2000]];
    let t = start;
    const dur = 4 + Math.random() * 3;
    while (t < start + dur) {
      const [a, b] = vowels[Math.floor(Math.random() * vowels.length)];
      const syl = 0.09 + Math.random() * 0.12;
      f1.frequency.setValueAtTime(a, t); f2.frequency.setValueAtTime(b, t);
      src.frequency.setValueAtTime(150 + Math.random() * 40, t);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol * 0.9, t + 0.02); g.gain.linearRampToValueAtTime(0, t + syl);
      t += syl + (Math.random() < 0.15 ? 0.25 : 0.02);
    }
    src.start(start); src.stop(t + 0.1);
  }

  thunder(dest: AudioNode, delay: number, vol: number) {
    const t = this.a.now + delay;
    this.noiseBurst(dest, t, 0.25, 'highpass', 900, 0.5, vol * 0.25);
    this.noiseBurst(dest, t + 0.05, 4 + Math.random() * 2, 'lowpass', 220, 0.8, vol, true);
    this.noiseBurst(dest, t + 0.4, 2.5, 'lowpass', 90, 0.8, vol * 0.8, true);
  }

  bell(dest: AudioNode, t: number, vol = 0.25) { this.tone(dest, t, 1480, 0.5, vol); this.tone(dest, t, 2350, 0.35, vol * 0.4); this.tone(dest, t, 3970, 0.2, vol * 0.15); }

  honk(dest: AudioNode, vol = 0.3) { const t = this.a.now; const n = 1 + Math.floor(Math.random() * 3); for (let i = 0; i < n; i++) { this.tone(dest, t + i * 0.3, 415, 0.2, vol, 'square', 0.01); this.tone(dest, t + i * 0.3, 520, 0.2, vol * 0.7, 'square', 0.01); } }

  chirp(dest: AudioNode, vol = 0.12) {
    const c = this.a.ctx, t = this.a.now;
    const n = 2 + Math.floor(Math.random() * 4);
    const base = 2200 + Math.random() * 2500;
    for (let i = 0; i < n; i++) {
      const o = c.createOscillator();
      const s = t + i * (0.09 + Math.random() * 0.05);
      o.frequency.setValueAtTime(base, s);
      o.frequency.exponentialRampToValueAtTime(base * (1.3 + Math.random() * 0.5), s + 0.06);
      o.connect(this.env(dest, s, vol, 0.005, 0.07));
      o.start(s); o.stop(s + 0.12);
    }
  }

  cricket(dest: AudioNode, vol = 0.05) { const t = this.a.now; for (let i = 0; i < 3; i++) this.tone(dest, t + i * 0.06, 4400, 0.035, vol); }
}
