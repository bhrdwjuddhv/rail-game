import { assets } from '../core/AssetRegistry';
import { bus } from '@rail/shared/events';
import type { LocoData } from '@rail/shared/train/Consist';
import type { AudioEngine } from './AudioEngine';
import { HornVoice } from './synth/Horn';
import { MotorVoice } from './synth/Motor';
import type { OneShots } from './synth/OneShots';
import { RollingVoice } from './synth/Wheels';

export interface TrainAudioState {
  speedKmph: number; amps: number; vcb: boolean; compressor: boolean; curvature: number;
  steelBridge: boolean; tunnel: boolean; slipping: boolean; bpRate: number; bc: number; overspeed: boolean;
  loco: { x: number; y: number; z: number };
  bogies: { key: number; km: number; x: number; y: number; z: number; axle: number }[];
  dt: number;
}

const LEVERS = new Set(['throttle', 'regen', 'trainBrake', 'locoBrake', 'reverser']);

/** All sounds made by the player's train, plus event-driven cab sounds. */
export class TrainAudio {
  private motor!: MotorVoice;
  private rolling!: RollingVoice;
  private hornLow!: HornVoice;
  private hornHigh!: HornVoice;
  readonly locoPan: PannerNode;
  private hornPan: PannerNode;
  private bogiePans = new Map<number, PannerNode>();
  private lastJoint = new Map<number, number>();
  private warnTimer = 0;
  private vigilance: 'ok' | 'warning' | 'penalty' = 'ok';
  private overTimer = 0;
  private speed = 0;
  private offs: (() => void)[] = [];
  ready = false;

  constructor(private a: AudioEngine, private shots: OneShots, private loco: LocoData, coachCount: number) {
    this.locoPan = a.panner('train', 12, 0.9);
    this.hornPan = a.panner('horn', 40, 0.7);
    const ui = a.buses.ui;
    this.offs.push(
      bus.on('control', e => { if (!this.ready) return; if (LEVERS.has(e.id)) shots.clunk(ui, 0.35); else shots.click(ui, 0.35); }),
      bus.on('horn', e => { if (!this.ready) return; (e.tone === 'low' ? this.hornLow : this.hornHigh).set(e.on); }),
      bus.on('coupler-jolt', e => this.ready && shots.couplerRipple(this.locoPan, Math.min(1, e.magnitude), Math.min(12, coachCount))),
      bus.on('vigilance', e => { this.vigilance = e.state; if (e.state === 'penalty') shots.buzz(ui, 0.3); }),
      bus.on('switch-crossed', () => this.ready && shots.switchClatter(this.locoPan, this.speed / 3.6, 0.5)),
      bus.on('lightning', e => this.ready && shots.thunder(a.buses.env, 0.4 + Math.random() * 3.5, 0.7 * e.intensity)),
      bus.on('pantograph', () => this.ready && shots.clunk(this.locoPan, 0.4)),
      bus.on('vcb', e => this.ready && shots.clunk(this.locoPan, e.closed ? 0.9 : 0.6)),
    );
  }

  async init() {
    const [motorBuf, rollBuf, hlBuf, hhBuf] = await Promise.all([
      assets.audio(this.a.ctx, 'train/motor'), assets.audio(this.a.ctx, 'train/rolling'),
      assets.audio(this.a.ctx, 'horn/low'), assets.audio(this.a.ctx, 'horn/high'),
    ]);
    this.motor = new MotorVoice(this.a, this.locoPan, motorBuf);
    this.rolling = new RollingVoice(this.a, this.locoPan, rollBuf);
    this.hornLow = new HornVoice(this.a, this.loco.soundProfile.hornLowHz, this.hornPan, hlBuf);
    this.hornHigh = new HornVoice(this.a, this.loco.soundProfile.hornHighHz, this.hornPan, hhBuf);
    this.ready = true;
  }

  update(s: TrainAudioState) {
    if (!this.ready) return;
    this.speed = s.speedKmph;
    this.a.setPannerPos(this.locoPan, s.loco.x, s.loco.y, s.loco.z);
    this.a.setPannerPos(this.hornPan, s.loco.x, s.loco.y + 4, s.loco.z);
    const sp = this.loco.soundProfile;
    this.motor.update(s.speedKmph, s.amps, s.vcb, s.compressor, sp.motorBaseHz, sp.motorHzPerKmph);
    this.rolling.update(s.dt, s.speedKmph, s.curvature, s.steelBridge, s.tunnel, s.slipping, s.bpRate, s.bc);

    // rail joints every 26 m: each bogie gives a double clack (two axles)
    const v = Math.abs(s.speedKmph) / 3.6;
    for (const b of s.bogies) {
      let pan = this.bogiePans.get(b.key);
      if (!pan) { pan = this.a.panner('train', 6, 1.4); this.bogiePans.set(b.key, pan); }
      this.a.setPannerPos(pan, b.x, b.y, b.z);
      const j = Math.floor((b.km * 1000) / 26);
      const last = this.lastJoint.get(b.key);
      this.lastJoint.set(b.key, j);
      if (last === undefined || last === j || v < 0.8) continue;
      const vol = Math.min(0.5, 0.12 + v / 70) * (s.steelBridge ? 1.4 : 1);
      const t = this.a.now;
      this.shots.clack(pan, t, vol, s.steelBridge ? 0.2 : 0.6);
      this.shots.clack(pan, t + b.axle / Math.max(v, 1), vol * 0.85, s.steelBridge ? 0.2 : 0.6);
    }

    // vigilance warning buzzer and overspeed beeper (in the cab)
    this.warnTimer -= s.dt;
    if (this.vigilance === 'warning' && this.warnTimer <= 0) { this.shots.buzz(this.a.buses.ui, 0.16); this.warnTimer = 1.1; }
    this.overTimer -= s.dt;
    if (s.overspeed && this.overTimer <= 0) { this.shots.beep(this.a.buses.ui, 0.15); this.overTimer = 0.9; }
  }

  honk(x: number, y: number, z: number) {
    const p = this.a.panner('env', 12, 1.2);
    this.a.setPannerPos(p, x, y, z);
    this.shots.honk(p, 0.25);
    setTimeout(() => p.disconnect(), 3000);
  }

  /** A train passing on the other line at relative speed `relMs`; louder in the cab with the window, and the faster it is. */
  passBy(x: number, y: number, z: number, relMs: number, lengthM: number, carM: number) {
    const p = this.a.panner('env', 8, 1.1);
    this.a.setPannerPos(p, x, y, z);
    const v = Math.max(1, relMs);
    this.shots.passBy(p, lengthM / v, carM / v, Math.min(0.9, 0.15 + v / 60));
    setTimeout(() => p.disconnect(), (lengthM / v + 3) * 1000);
  }

  announce(x: number, y: number, z: number) {
    const p = this.a.panner('env', 30, 1.1);
    this.a.setPannerPos(p, x, y + 6, z);
    this.shots.announcement(p, 0.45);
    setTimeout(() => p.disconnect(), 12000);
  }

  dispose() { for (const o of this.offs) o(); }
}
