import { bus } from '../events';
import { approach, clamp } from '../util';
import type { LocoData } from './Consist';
import { BRAKE_POSITIONS, BrakeSystem } from '../physics/BrakeSystem';

export const VIGILANCE_PERIOD = 60;
export const VIGILANCE_GRACE = 8;
/** pantograph travel times (s): the 3D model and the touch button both follow pantoPos */
export const PANTO_RAISE_S = 3.5;
export const PANTO_LOWER_S = 2.5;

/**
 * Driver-controllable loco state: master controller, reverser, pantograph,
 * main breaker (VCB), lights, wipers, sander, horn, vigilance and overspeed.
 * Every change is announced on the event bus ('control') so cab animations,
 * sounds and the HUD react without importing this module.
 */
export class LocoSystems {
  notch = 0;
  regen = 0;
  reverser: -1 | 0 | 1 = 0;
  pantoUp = false;       // switch position
  pantoPos = 0;          // 0 down .. 1 touching the wire
  vcb = false;
  headlight = 0;         // 0 off, 1 dim, 2 bright
  cabLight = false;
  markers = true;
  flasher = false;
  wipers = 0;            // 0 off, 1 slow, 2 fast
  sander = false;
  hornLow = false;
  hornHigh = false;
  lineVoltage = 0;       // kV
  vigilanceTimer = 0;
  vigilanceState: 'ok' | 'warning' | 'penalty' = 'ok';
  overspeed = false;
  emergencyStop = false;
  /** God Mode can switch the vigilance control device off */
  vigilanceEnabled = true;
  /** God Mode: ignore the loco's own max speed for the overspeed warning */
  ignoreMaxSpeed = false;
  private t = 0;

  constructor(readonly loco: LocoData, private brakes: BrakeSystem) {}

  get powerAvailable() { return this.vcb && this.lineVoltage > 19 && !this.brakes.penalty && !this.emergencyStop; }
  get pantoDown() { return this.pantoPos < 0.99; }
  /** pantograph still travelling toward its switch position */
  get pantoMoving() { return this.pantoUp ? this.pantoPos < 0.999 : this.pantoPos > 0.001; }

  private emit(id: string, value: number | string | boolean) { bus.emit('control', { id, value }); }

  // ---- driver actions ----
  /** Notching up with the pantograph down does nothing useful: say why (the notch still moves, as on the real controller). */
  private pantoHint(from: number, to: number) {
    if (to > from && this.pantoPos < 0.99) bus.emit('needs-pantograph', { action: 'throttle' });
  }
  throttle(delta: number) {
    if (delta > 0 && this.regen > 0) { this.regen = 0; this.emit('regen', 0); return; }
    this.pantoHint(this.notch, this.notch + delta);
    const n = clamp(this.notch + delta, 0, this.loco.notches);
    if (n !== this.notch) { this.notch = n; this.emit('throttle', n); }
  }
  setThrottle(n: number) { const v = clamp(Math.round(n), 0, this.loco.notches); this.pantoHint(this.notch, v); if (v !== this.notch) { if (v > 0) this.regen = 0; this.notch = v; this.emit('throttle', v); } }
  regenStep(delta: number) {
    if (delta > 0 && this.notch > 0) { this.notch = 0; this.emit('throttle', 0); return; }
    const n = clamp(this.regen + delta, 0, this.loco.regen.notches);
    if (n !== this.regen) { this.regen = n; this.emit('regen', n); }
  }
  setReverser(r: -1 | 0 | 1) {
    if (r === this.reverser) return;
    if (this.notch > 0) { bus.emit('message', { text: 'Close the throttle before moving the reverser', kind: 'warn' }); return; }
    this.reverser = r; this.emit('reverser', r);
  }
  reverserStep(d: number) { this.setReverser(clamp(this.reverser + d, -1, 1) as -1 | 0 | 1); }
  trainBrake(delta: number) {
    const h = clamp(this.brakes.handle + delta, 0, BRAKE_POSITIONS.length - 1);
    if (h !== this.brakes.handle) { this.brakes.handle = h; this.emit('trainBrake', h); }
  }
  setTrainBrake(h: number) { const v = clamp(Math.round(h), 0, BRAKE_POSITIONS.length - 1); if (v !== this.brakes.handle) { this.brakes.handle = v; this.emit('trainBrake', v); } }
  locoBrake(delta: number) {
    const v = clamp(Math.round((this.brakes.independent + delta) * 4) / 4, 0, 1);
    if (v !== this.brakes.independent) { this.brakes.independent = v; this.emit('locoBrake', v); }
  }
  emergency() {
    this.brakes.handle = BRAKE_POSITIONS.length - 1;
    this.notch = 0; this.regen = 0;
    this.emit('trainBrake', this.brakes.handle);
    this.emit('throttle', 0);
  }
  emergencyButton() {
    this.emergencyStop = !this.emergencyStop;
    if (this.emergencyStop) { this.emergency(); this.openVcb(); }
    this.emit('emergencyStop', this.emergencyStop);
  }
  togglePanto() {
    this.pantoUp = !this.pantoUp;
    if (!this.pantoUp) this.openVcb();
    this.emit('panto', this.pantoUp);
    bus.emit('pantograph', { up: this.pantoUp });
  }
  toggleVcb() {
    if (this.vcb) { this.openVcb(); return; }
    if (this.pantoPos < 0.99) { bus.emit('needs-pantograph', { action: 'vcb' }); return; }
    if (this.notch > 0) { bus.emit('message', { text: 'Throttle must be at 0 to close the VCB', kind: 'warn' }); return; }
    if (this.emergencyStop) { bus.emit('message', { text: 'Reset the emergency stop button first', kind: 'warn' }); return; }
    this.vcb = true; this.emit('vcb', true); bus.emit('vcb', { closed: true });
  }
  private openVcb() { if (this.vcb) { this.vcb = false; this.notch = 0; this.regen = 0; this.emit('vcb', false); bus.emit('vcb', { closed: false }); } }
  cycleHeadlight() { this.headlight = (this.headlight + 1) % 3; this.emit('headlight', this.headlight); }
  toggleCabLight() { this.cabLight = !this.cabLight; this.emit('cabLight', this.cabLight); }
  toggleMarkers() { this.markers = !this.markers; this.emit('markers', this.markers); }
  toggleFlasher() { this.flasher = !this.flasher; this.emit('flasher', this.flasher); }
  cycleWipers() { this.wipers = (this.wipers + 1) % 3; this.emit('wipers', this.wipers); }
  setSander(on: boolean) { if (on !== this.sander) { this.sander = on; this.emit('sander', on); } }
  setHorn(tone: 'low' | 'high', on: boolean) {
    const cur = tone === 'low' ? this.hornLow : this.hornHigh;
    if (cur === on) return;
    if (tone === 'low') this.hornLow = on; else this.hornHigh = on;
    bus.emit('horn', { on, tone });
  }
  acknowledgeVigilance(speed: number) {
    this.vigilanceTimer = 0;
    if (this.vigilanceState === 'penalty') {
      if (Math.abs(speed) < 0.1) {
        this.vigilanceState = 'ok';
        this.brakes.penalty = false;
        bus.emit('vigilance', { state: 'ok' });
        bus.emit('message', { text: 'Vigilance penalty reset. Release brakes to continue.', kind: 'info' });
      } else bus.emit('message', { text: 'Penalty brake: wait for the train to stop', kind: 'warn' });
    } else if (this.vigilanceState === 'warning') {
      this.vigilanceState = 'ok';
      bus.emit('vigilance', { state: 'ok' });
    }
    this.emit('vigilance', true);
  }

  update(dt: number, speed: number, limitKmph: number, wired: boolean) {
    this.t += dt;
    this.pantoPos = approach(this.pantoPos, this.pantoUp ? 1 : 0, this.pantoUp ? 1 / PANTO_RAISE_S : 1 / PANTO_LOWER_S, dt);
    const touching = this.pantoPos > 0.99 && wired;
    this.lineVoltage = touching ? this.loco.electrical.lineVoltageKV + Math.sin(this.t * 0.7) * 0.6 + Math.sin(this.t * 3.1) * 0.25 : 0;
    if (this.vcb && !touching) this.openVcb();

    // vigilance control device
    if (!this.vigilanceEnabled) { this.vigilanceTimer = 0; if (this.vigilanceState === 'warning') { this.vigilanceState = 'ok'; bus.emit('vigilance', { state: 'ok' }); } }
    else if (Math.abs(speed) > 0.3 && this.vigilanceState !== 'penalty') {
      this.vigilanceTimer += dt;
      if (this.vigilanceState === 'ok' && this.vigilanceTimer > VIGILANCE_PERIOD) {
        this.vigilanceState = 'warning';
        bus.emit('vigilance', { state: 'warning' });
      }
      if (this.vigilanceState === 'warning' && this.vigilanceTimer > VIGILANCE_PERIOD + VIGILANCE_GRACE) {
        this.vigilanceState = 'penalty';
        this.brakes.penalty = true;
        this.notch = 0; this.regen = 0;
        bus.emit('vigilance', { state: 'penalty' });
        bus.emit('message', { text: 'VIGILANCE PENALTY BRAKE APPLIED', kind: 'penalty', ms: 5000 });
      }
    }
    const kmph = Math.abs(speed) * 3.6;
    this.overspeed = kmph > Math.min(limitKmph, this.ignoreMaxSpeed ? Infinity : this.loco.maxSpeedKmph) + 2;
  }
}
