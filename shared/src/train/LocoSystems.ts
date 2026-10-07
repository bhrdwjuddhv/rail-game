import { bus } from '../events';
import { approach, clamp } from '../util';
import type { LocoData } from './Consist';
import { BRAKE_POSITIONS, BrakeSystem } from '../physics/BrakeSystem';

export const VIGILANCE_PERIOD = 60;
export const VIGILANCE_GRACE = 8;
/** pantograph travel times (s): the 3D model and the touch button both follow pantoPos */
export const PANTO_RAISE_S = 3.5;
export const PANTO_LOWER_S = 2.5;
/** the main breaker (VCB) takes this long to close after the command */
export const VCB_CLOSE_S = 1;
/** line voltage (kV) below which the VCB will not close or stay closed */
export const MIN_LINE_KV = 19;

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
  /** seconds until a commanded VCB close completes (0 = not closing) */
  vcbClosing = 0;
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
  // ---- diesel (type "diesel"): fuel pump, engine start / stop
  fuelPump = false;
  engine: 'stopped' | 'cranking' | 'running' = 'stopped';
  engineRpm = 0;
  private crank = 0;
  private t = 0;

  constructor(readonly loco: LocoData, private brakes: BrakeSystem) {}

  get isDiesel() { return this.loco.type === 'diesel'; }
  get powerAvailable() {
    const supply = this.isDiesel ? this.engine === 'running' : this.vcb && this.lineVoltage > MIN_LINE_KV;
    return supply && !this.brakes.penalty && !this.emergencyStop;
  }
  /** vigilance: seconds left before the penalty brake (while the warning is on) */
  get vigilanceLeft() { return Math.max(0, VIGILANCE_PERIOD + VIGILANCE_GRACE - this.vigilanceTimer); }
  get pantoDown() { return this.pantoPos < 0.99; }
  /** pantograph still travelling toward its switch position */
  get pantoMoving() { return this.pantoUp ? this.pantoPos < 0.999 : this.pantoPos > 0.001; }

  private emit(id: string, value: number | string | boolean) { bus.emit('control', { id, value }); }

  // ---- driver actions ----
  /** Notching up with the pantograph down does nothing useful: say why (the notch still moves, as on the real controller). */
  private pantoHint(from: number, to: number) {
    if (to <= from) return;
    if (this.isDiesel) { if (this.engine !== 'running') bus.emit('needs-engine', { action: 'throttle' }); }
    else if (this.pantoPos < 0.99) bus.emit('needs-pantograph', { action: 'throttle' });
  }
  private dieselOnly(what: string) { bus.emit('message', { text: `Diesel loco: no ${what} - use Fuel pump, then Engine start`, kind: 'info' }); }

  /** Diesel: the fuel pump primes the engine; switching it off stops a running engine. */
  toggleFuelPump() {
    if (!this.isDiesel) return;
    this.fuelPump = !this.fuelPump;
    this.emit('fuelPump', this.fuelPump);
    if (!this.fuelPump && this.engine !== 'stopped') this.stopEngine();
  }
  /**
   * Diesel engine start / stop. Starting needs the fuel pump on and the
   * throttle at idle; the engine cranks for diesel.crankS, then fires and
   * settles at idle. Stop shuts it down (power is lost at once).
   */
  toggleEngine() {
    if (!this.isDiesel) return;
    if (this.engine !== 'stopped') { this.stopEngine(); return; }
    if (!this.fuelPump) { bus.emit('needs-engine', { action: 'start' }); bus.emit('message', { text: 'Switch the fuel pump on first', kind: 'warn' }); return; }
    if (this.notch > 0) { bus.emit('message', { text: 'Throttle must be at idle to start the engine', kind: 'warn' }); return; }
    this.engine = 'cranking';
    this.crank = this.loco.diesel?.crankS ?? 4;
    this.emit('engine', 'cranking');
    bus.emit('engine', { state: 'cranking' });
  }
  private stopEngine() {
    this.engine = 'stopped'; this.notch = 0; this.regen = 0;
    this.emit('engine', 'stopped');
    bus.emit('engine', { state: 'stopped' });
  }
  /**
   * Driver activity (a real throttle or brake movement) resets the vigilance
   * timer and silences a warning, as on real vigilance control devices. A
   * penalty still needs the train stopped and an explicit acknowledge.
   */
  private active() {
    if (this.vigilanceState === 'penalty') return;
    this.vigilanceTimer = 0;
    if (this.vigilanceState === 'warning') { this.vigilanceState = 'ok'; bus.emit('vigilance', { state: 'ok' }); }
  }
  throttle(delta: number) {
    if (delta > 0 && this.regen > 0) { this.regen = 0; this.emit('regen', 0); this.active(); return; }
    this.pantoHint(this.notch, this.notch + delta);
    const n = clamp(this.notch + delta, 0, this.loco.notches);
    if (n !== this.notch) { this.notch = n; this.emit('throttle', n); this.active(); }
  }
  setThrottle(n: number) { const v = clamp(Math.round(n), 0, this.loco.notches); this.pantoHint(this.notch, v); if (v !== this.notch) { if (v > 0) this.regen = 0; this.notch = v; this.emit('throttle', v); this.active(); } }
  regenStep(delta: number) {
    if (delta > 0 && this.notch > 0) { this.notch = 0; this.emit('throttle', 0); this.active(); return; }
    const n = clamp(this.regen + delta, 0, this.loco.regen.notches);
    if (n !== this.regen) { this.regen = n; this.emit('regen', n); this.active(); }
  }
  setReverser(r: -1 | 0 | 1) {
    if (r === this.reverser) return;
    if (this.notch > 0) { bus.emit('message', { text: 'Close the throttle before moving the reverser', kind: 'warn' }); return; }
    this.reverser = r; this.emit('reverser', r);
  }
  reverserStep(d: number) { this.setReverser(clamp(this.reverser + d, -1, 1) as -1 | 0 | 1); }
  trainBrake(delta: number) {
    const h = clamp(this.brakes.handle + delta, 0, BRAKE_POSITIONS.length - 1);
    if (h !== this.brakes.handle) { this.brakes.handle = h; this.emit('trainBrake', h); this.active(); }
  }
  setTrainBrake(h: number) { const v = clamp(Math.round(h), 0, BRAKE_POSITIONS.length - 1); if (v !== this.brakes.handle) { this.brakes.handle = v; this.emit('trainBrake', v); this.active(); } }
  locoBrake(delta: number) {
    const v = clamp(Math.round((this.brakes.independent + delta) * 4) / 4, 0, 1);
    if (v !== this.brakes.independent) { this.brakes.independent = v; this.emit('locoBrake', v); this.active(); }
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
    if (this.isDiesel) { this.dieselOnly('pantograph'); return; }
    this.pantoUp = !this.pantoUp;
    if (!this.pantoUp) this.openVcb();
    this.emit('panto', this.pantoUp);
    bus.emit('pantograph', { up: this.pantoUp });
  }
  /**
   * Main breaker. Opening is immediate; closing needs the pantograph on the
   * wire with line voltage, throttle at 0 and no emergency stop, and takes
   * VCB_CLOSE_S (the LED shows amber meanwhile). A second press while it
   * closes changes nothing.
   */
  toggleVcb() {
    if (this.isDiesel) { this.dieselOnly('main breaker'); return; }
    if (this.vcb) { this.openVcb(); return; }
    if (this.vcbClosing > 0) return;
    if (this.pantoPos < 0.99) { bus.emit('needs-pantograph', { action: 'vcb' }); return; }
    if (this.lineVoltage < MIN_LINE_KV) { bus.emit('message', { text: 'No line voltage: the VCB cannot close here', kind: 'warn' }); return; }
    if (this.notch > 0) { bus.emit('message', { text: 'Throttle must be at 0 to close the VCB', kind: 'warn' }); return; }
    if (this.emergencyStop) { bus.emit('message', { text: 'Reset the emergency stop button first', kind: 'warn' }); return; }
    this.vcbClosing = VCB_CLOSE_S;
    this.emit('vcbClosing', true);
  }
  private openVcb() {
    if (this.vcbClosing > 0) { this.vcbClosing = 0; this.emit('vcbClosing', false); }
    if (this.vcb) { this.vcb = false; this.notch = 0; this.regen = 0; this.emit('vcb', false); bus.emit('vcb', { closed: false }); }
  }
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
    if ((this.vcb || this.vcbClosing > 0) && !touching) this.openVcb();
    // diesel engine: cranking, then rpm follows the notch (governor)
    const D = this.loco.diesel;
    if (D) {
      if (this.engine === 'cranking') {
        this.crank -= dt;
        this.engineRpm = approach(this.engineRpm, D.idleRpm * 0.35, D.idleRpm, dt);
        if (this.crank <= 0) { this.engine = 'running'; this.emit('engine', 'running'); bus.emit('engine', { state: 'running' }); }
      } else {
        const target = this.engine === 'running' ? D.idleRpm + (D.maxRpm - D.idleRpm) * (this.notch / this.loco.notches) : 0;
        this.engineRpm = approach(this.engineRpm, target, target > this.engineRpm ? 90 : 160, dt);
      }
    }
    if (this.vcbClosing > 0) {
      this.vcbClosing = Math.max(0, this.vcbClosing - dt);
      if (this.vcbClosing === 0) { this.vcb = true; this.emit('vcb', true); bus.emit('vcb', { closed: true }); }
    }

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
        bus.emit('message', { text: `Vigilance not acknowledged within ${VIGILANCE_GRACE} s: emergency brake applied. Stop, then acknowledge to reset.`, kind: 'penalty', ms: 7000 });
      }
    }
    const kmph = Math.abs(speed) * 3.6;
    this.overspeed = kmph > Math.min(limitKmph, this.ignoreMaxSpeed ? Infinity : this.loco.maxSpeedKmph) + 2;
  }
}
