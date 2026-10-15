import type { AudioEngine } from './AudioEngine';

/** recorded station announcements (client/public/assets/announcement) */
const FILES = ['railannouncement1.mp3', 'announcement2.mp3', 'announcement3.mp3'];
/** silence between two announcements (s) */
const GAP_S = [2.5, 6];

/**
 * Station announcements over the platform loudspeakers, as at a real station:
 * from when the player's train is about to reach a station until it has left
 * it behind, one recorded announcement after another, each picked at random
 * (never the same twice running), with a short pause between. Heard from the
 * station's position (quieter far off, muffled in the cab); fades out as the
 * train leaves. The recordings load on first use.
 */
export class StationAnnouncer {
  private buffers: AudioBuffer[] = [];
  private loading: Promise<void> | null = null;
  private code: string | null = null;
  private src: AudioBufferSourceNode | null = null;
  private last = -1;
  private wait = 0;
  private readonly gain: GainNode;
  private readonly pan: PannerNode;

  constructor(private a: AudioEngine) {
    this.pan = a.panner('station', 45, 0.9);
    this.gain = a.ctx.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(this.pan);
  }

  private load() {
    this.loading ??= Promise.all(FILES.map(f => fetch(`${import.meta.env.BASE_URL}assets/announcement/${f}`)
      .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${f}: ${r.status}`))))
      .then(b => this.a.ctx.decodeAudioData(b))
      .catch(e => { console.warn('[audio] station announcement not loaded:', e); return null; })))
      .then(list => { this.buffers = list.filter((b): b is AudioBuffer => !!b); });
    return this.loading;
  }

  /**
   * Every frame: the station the player's train is at or coming to (its code and the loudspeakers'
   * position), or null once it has gone away.
   */
  update(dt: number, at: { code: string; x: number; y: number; z: number } | null) {
    const t = this.a.now;
    if (!at) {
      if (this.code) { this.gain.gain.setTargetAtTime(0, t, 0.8); this.code = null; this.wait = 0; setTimeout(() => { if (!this.code) this.stop(); }, 3000); }
      return;
    }
    this.a.setPannerPos(this.pan, at.x, at.y, at.z);
    if (at.code !== this.code) {
      // a new station: start at once (a short pause, as if the announcer had just picked up the microphone)
      this.stop();
      this.code = at.code;
      this.wait = 0.8;
      this.gain.gain.cancelScheduledValues(t);
      this.gain.gain.setTargetAtTime(0.9, t, 0.3);
      void this.load();
    }
    if (this.src || !this.buffers.length) return;
    this.wait -= dt;
    if (this.wait > 0) return;
    let i = Math.floor(Math.random() * this.buffers.length);
    if (this.buffers.length > 1 && i === this.last) i = (i + 1) % this.buffers.length;
    this.last = i;
    const s = this.a.ctx.createBufferSource();
    s.buffer = this.buffers[i];
    s.connect(this.gain);
    s.onended = () => { if (this.src === s) { this.src = null; this.wait = GAP_S[0] + Math.random() * (GAP_S[1] - GAP_S[0]); } };
    s.start();
    this.src = s;
  }

  private stop() {
    if (!this.src) return;
    const s = this.src;
    this.src = null;
    try { s.stop(); } catch { /* already ended */ }
    s.disconnect();
  }

  dispose() { this.stop(); this.gain.disconnect(); this.pan.disconnect(); }
}
