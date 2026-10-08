import * as THREE from 'three/webgpu';
import { GeoBatch, mat } from '../../core/GeoBatch';
import { materials } from '../../core/Materials';
import { Atlas, uvToRect } from '../../core/Textures';
import { BRAKE_POSITIONS, BrakeSystem } from '@rail/shared/physics/BrakeSystem';
import type { LocoSystems } from '@rail/shared/train/LocoSystems';
import type { CabLayout } from './CabModel';
import { DriverDisplay, Gauge, LampPanel } from './Gauges';

export const CONTROL_NAMES: Record<string, string> = {
  throttle: 'Master controller (D / A)', regen: 'Regenerative brake (C / Z)', reverser: 'Reverser (W / S)',
  trainBrake: "Automatic train brake (' / ;)", locoBrake: 'Independent loco brake (] / [)',
  hornLow: 'Horn - low tone (Space)', hornHigh: 'Horn - high tone (Shift+Space)', headlight: 'Headlight off/dim/bright (L)',
  cabLight: 'Cab light (K)', markers: 'Marker lights (N)', flasher: 'Flasher (B)', panto: 'Pantograph up/down (P)',
  fuelPump: 'Fuel pump on/off (U)', engine: 'Engine start/stop (E)',
  vcb: 'Main circuit breaker VCB (O)', wipers: 'Wipers off/slow/fast (V)', sander: 'Sander (X, hold)', vigilance: 'Vigilance acknowledge (Q)',
  emergencyStop: 'Emergency stop button', emergencyBrake: 'Emergency brake (Backspace)',
};

export interface CabReadings {
  speedKmph: number; limit: number; bp: number; bc: number; mr: number; er: number; kV: number; amps: number; teKN: number;
  slip: boolean; overspeed: boolean; vigilance: 'ok' | 'warning' | 'penalty'; brakeApplied: boolean; pantoDown: boolean; vcbOpen: boolean;
  km: number; nextSignal: string; signalDist: number; aspect: string; clock: string; units: string; displaySpeed: number;
}

const LAMPS = ['slip', 'overspeed', 'vigilance', 'brake', 'panto', 'vcb'] as const;

interface Ctl { id: string; moving: THREE.Object3D; hit: THREE.Mesh }

/**
 * All interactive cab controls. Draw-call budget: static parts (bases,
 * bezels, caps) are one merged mesh; every label and dial face lives in one
 * canvas atlas (one mesh); each control's moving part is a single merged mesh;
 * warning lamps are one instanced mesh. Invisible hit boxes do the raycasting.
 */
export class CabControls {
  readonly group = new THREE.Group();
  readonly hitTargets: THREE.Mesh[] = [];
  private ctl = new Map<string, Ctl>();
  private gauges: Record<string, Gauge> = {};
  private lamps: LampPanel;
  /** the LCD driver display (modern cabs only) */
  private display: DriverDisplay | null = null;
  private displayTimer = 0;
  private blink = 0;
  private faceMat: THREE.MeshStandardMaterial;

  constructor(L: CabLayout, private sys: LocoSystems, private brakes: BrakeSystem) {
    const f = L.front;
    const deskY = (x: number) => L.deskTop + (x - (f - 0.78)) * Math.tan(0.18) + 0.03;
    const atlas = new Atlas(1024, 1024);
    const M = materials();
    this.faceMat = new THREE.MeshStandardMaterial({ map: atlas.texture, vertexColors: true, roughness: 0.45, emissive: 0xffffff, emissiveMap: atlas.texture, emissiveIntensity: 0 });

    // ---- instrument panel (gauges + lamps + display), faces the driver ----
    const panel = new THREE.Object3D();
    panel.position.set(f - (L.vintage ? 0.48 : 0.43), L.panelY ?? L.deskTop + 0.2, -0.75);
    panel.lookAt(new THREE.Vector3().copy(L.eye).add(new THREE.Vector3(0, 0, -0.05)));
    panel.translateZ(0.045);
    this.group.add(panel);
    const pFaces = new GeoBatch(), pStatic = new GeoBatch();
    const addG = (id: string, x: number, y: number, label: string, min: number, max: number, unit: string, r: number, o: ConstructorParameters<typeof Gauge>[11] = {}) => {
      this.gauges[id] = new Gauge(atlas, pFaces, pStatic, panel, x, y, label, min, max, unit, r, o);
    };
    const diesel = sys.isDiesel, old = !!L.vintage;
    if (old) {
      // older diesel: a row of big round gauges, no display; the speedometer has its own box on the desk
      addG('mr', -0.48, 0.03, 'MR', 0, 12, 'kg/cm²', 0.072, { majors: 6 });
      addG('bpbc', -0.25, 0.03, 'BP / BC', 0, 10, 'kg/cm²', 0.082, { majors: 5, needles: ['BP', 'BC'] });
      addG('amps', 0.0, 0.03, 'LOAD', 0, 1200, 'A', 0.082, { majors: 6, redFrom: 1000 });
      addG('kv', 0.25, 0.03, 'ENGINE', 0, 1200, 'rpm', 0.072, { majors: 6, redFrom: 1100 });
      const box = new THREE.Object3D();
      box.position.set(f - 0.7, L.deskTop + 0.36, -0.1);
      box.lookAt(L.eye);
      this.group.add(box);
      const sFaces = new GeoBatch(), sStatic = new GeoBatch();
      sStatic.box(0.27, 0.3, 0.18, mat(0, -0.01, -0.095), '#4b5a52', 'metal');
      sStatic.box(0.06, 0.22, 0.06, mat(0, -0.2, -0.12), '#3c4842', 'metal');
      this.gauges.speed = new Gauge(atlas, sFaces, sStatic, box, 0, 0.0, 'km/h', 0, 140, 'SPEED', 0.105, { majors: 7, redFrom: 120 });
      const mats0 = { ...(M as unknown as Record<string, THREE.Material>), faces: this.faceMat };
      box.add(sFaces.build(mats0, false), sStatic.build(mats0, false));
    } else {
      addG('speed', 0, 0, 'km/h', 0, 160, 'SPEED', 0.1, { majors: 8, redFrom: 140 });
      addG('bpbc', -0.29, 0.07, 'BP / BC', 0, 10, 'kg/cm²', 0.068, { majors: 5, needles: ['BP', 'BC'] });
      addG('mr', -0.46, 0.07, 'MR', 0, 12, 'kg/cm²', 0.06, { majors: 6 });
      // diesel: the OHE voltmeter is an engine tachometer
      if (diesel) addG('kv', 0.29, 0.07, 'ENGINE', 0, 1200, 'rpm', 0.06, { majors: 6, redFrom: 1100 });
      else addG('kv', 0.29, 0.07, 'OHE', 0, 32, 'kV', 0.06, { majors: 8, redFrom: 29 });
      addG('amps', 0.46, 0.07, 'TM', 0, 1200, 'A', 0.06, { majors: 6, redFrom: 1000 });
      addG('te', -0.29, -0.1, 'TE', 0, 350, 'kN', 0.055, { majors: 7 });
      this.display = new DriverDisplay(0.26, 0.16);
      this.display.mesh.position.set(0.37, -0.1, 0.002);
      panel.add(this.display.mesh);
    }
    const lampDefs: [string, number][] = [['SLIP', 0xffb000], ['OVERSPEED', 0xff2a1a], ['VCD', 0xffd000], ['BRAKE', 0xff5a1a], diesel ? ['FUEL OFF', 0x3aa0ff] : ['PANTO DN', 0x3aa0ff], diesel ? ['ENG STOP', 0xff2a1a] : ['VCB OPEN', 0xff2a1a]];
    this.lamps = new LampPanel(atlas, pFaces, lampDefs.map(([label, color], i) => ({ label, color, x: -0.45 + i * 0.18, y: 0.18 })));
    panel.add(this.lamps.mesh);

    // ---- desk controls ----
    const dStatic = new GeoBatch(), dFaces = new GeoBatch();
    const labelOnDesk = (text: string, w: number, x: number, y: number, z: number) => {
      const r = atlas.add(256, 48, g => { g.fillStyle = '#191b1d'; g.fillRect(0, 0, 256, 48); g.fillStyle = '#e8e8e8'; g.font = 'bold 26px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 128, 26); });
      // flat on the desk, text reading away from the driver
      dFaces.add(uvToRect(new THREE.PlaneGeometry(w, (w * 48) / 256), r), mat(x, y + 0.002, z, 0, -Math.PI / 2, -Math.PI / 2), '#ffffff', 'faces');
    };
    /** One merged mesh for a control's moving part (vertex-coloured). */
    const movingMesh = (build: (b: GeoBatch) => void) => {
      const b = new GeoBatch();
      build(b);
      const g = b.geometry('metal')!;
      return new THREE.Mesh(g, M.metal);
    };

    const lever = (id: string, x: number, z: number, len: number, color: string, axis: 'z' | 'y', text: string) => {
      const y = deskY(x);
      dStatic.cyl(0.045, 0.05, 0.03, 16, mat(x, y, z), '#1f2226', 'metal');
      const moving = new THREE.Object3D();
      moving.position.set(x, y + 0.02, z);
      moving.add(movingMesh(b => {
        if (axis === 'z') { b.cyl(0.012, 0.012, len, 8, mat(0, len / 2, 0), '#b8bcc0', 'metal'); b.add(new THREE.SphereGeometry(0.026, 12, 10), mat(0, len, 0), color, 'metal'); }
        else { b.cyl(0.012, 0.012, len, 8, mat(len / 2, 0.03, 0, 0, 0, Math.PI / 2), '#b8bcc0', 'metal'); b.add(new THREE.SphereGeometry(0.026, 12, 10), mat(len, 0.03, 0), color, 'metal'); }
      }));
      labelOnDesk(text, 0.1, x - 0.07, y, z);
      this.add(id, moving, x, y, z, axis === 'z' ? new THREE.Vector3(0.1, len + 0.05, 0.08) : new THREE.Vector3(len + 0.05, 0.08, len + 0.05));
    };
    lever('throttle', f - 0.8, -1.2, 0.2, '#1f7a3a', 'z', 'POWER');
    lever('regen', f - 0.8, -1.34, 0.16, '#2156a8', 'z', 'REGEN');
    lever('trainBrake', f - 0.92, -0.3, 0.2, '#b52a1d', 'y', 'A9 BRAKE');
    lever('locoBrake', f - 1.02, -0.1, 0.15, '#9a6b1d', 'y', 'SA9');
    {
      const x = f - 0.98, y = deskY(x), z = -1.06;
      dStatic.cyl(0.04, 0.04, 0.02, 16, mat(x, y, z), '#1f2226', 'metal');
      const moving = new THREE.Object3D();
      moving.position.set(x, y, z);
      moving.add(movingMesh(b => b.box(0.09, 0.04, 0.02, mat(0, 0.03, 0), '#d9b44a', 'metal')));
      labelOnDesk('F  N  R', 0.09, x - 0.06, y, z);
      this.add('reverser', moving, x, y, z, new THREE.Vector3(0.1, 0.08, 0.1));
    }
    const button = (id: string, x: number, z: number, r: number, color: string, text: string, mushroom = false) => {
      const y = deskY(x);
      dStatic.cyl(r * 1.3, r * 1.3, 0.015, 16, mat(x, y, z), '#1f2226', 'metal');
      const moving = new THREE.Object3D();
      moving.position.set(x, y, z);
      moving.add(movingMesh(b => {
        if (mushroom) b.add(new THREE.SphereGeometry(r, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat(0, 0.012, 0), color, 'metal');
        else b.cyl(r, r, 0.02, 16, mat(0, 0.018, 0), color, 'metal');
      }));
      labelOnDesk(text, 0.09, x - r - 0.04, y, z);
      this.add(id, moving, x, y, z, new THREE.Vector3(r * 2.6, 0.06, r * 2.6));
    };
    button('hornLow', f - 1.02, -1.38, 0.022, '#444444', 'HORN LO');
    button('hornHigh', f - 1.02, -1.27, 0.022, '#777777', 'HORN HI');
    button('vigilance', f - 1.06, -0.5, 0.032, '#f2c200', 'VCD');
    button('sander', f - 1.06, -0.66, 0.022, '#8b5a2b', 'SAND');
    button('emergencyStop', f - 0.62, -0.06, 0.035, '#d01010', 'EMERG', true);
    const toggle = (id: string, z: number, text: string, rotary = false) => {
      const x = f - 0.56, y = deskY(x);
      dStatic.box(0.05, 0.012, 0.05, mat(x, y, z), '#1f2226', 'metal');
      const moving = new THREE.Object3D();
      moving.position.set(x, y + 0.008, z);
      moving.add(movingMesh(b => {
        if (rotary) { b.cyl(0.018, 0.02, 0.025, 12, mat(0, 0.012, 0), '#222222', 'metal'); b.box(0.004, 0.027, 0.03, mat(0, 0.012, 0), '#ffffff', 'metal'); }
        else b.cyl(0.005, 0.007, 0.04, 8, mat(0, 0.02, 0), '#b8bcc0', 'metal');
      }));
      labelOnDesk(text, 0.07, x + 0.045, y, z);
      this.add(id, moving, x, y, z, new THREE.Vector3(0.06, 0.06, 0.06));
    };
    if (diesel) { toggle('fuelPump', -1.3, 'FUEL PUMP'); toggle('engine', -1.18, 'ENGINE'); }
    else { toggle('panto', -1.3, 'PANTO'); toggle('vcb', -1.18, 'VCB'); }
    toggle('headlight', -1.06, 'HEAD LT', true);
    toggle('markers', -0.94, 'MARKER');
    toggle('flasher', -0.82, 'FLASHER');
    toggle('cabLight', -0.7, 'CAB LT');
    toggle('wipers', -0.58, 'WIPER', true);

    const mats = { ...(M as unknown as Record<string, THREE.Material>), faces: this.faceMat };
    panel.add(pFaces.build(mats, false), pStatic.build(mats, false));
    this.group.add(dFaces.build(mats, false), dStatic.build(mats, false));
  }

  private add(id: string, moving: THREE.Object3D, x: number, y: number, z: number, hitSize: THREE.Vector3) {
    const hit = new THREE.Mesh(new THREE.BoxGeometry(hitSize.x, hitSize.y, hitSize.z), new THREE.MeshBasicMaterial());
    hit.position.set(x, y + hitSize.y / 2, z);
    hit.visible = false;
    hit.userData.control = id;
    this.group.add(hit, moving);
    this.hitTargets.push(hit);
    this.ctl.set(id, { id, moving, hit });
  }

  /** Object to highlight for a control id, "gauge:<id>" or "display" (null if unknown). */
  anchor(id: string): THREE.Object3D | null {
    if (id === 'display') return this.display?.mesh ?? this.gauges.speed.anchor;
    if (id.startsWith('gauge:')) return this.gauges[id.slice(6)]?.anchor ?? null;
    return this.ctl.get(id)?.hit ?? null;
  }

  /** Mouse press on a control. button 0 = increase/toggle, 2 = decrease. */
  press(id: string, button: number, speed: number) {
    const s = this.sys, inc = button === 2 ? -1 : 1;
    switch (id) {
      case 'throttle': s.throttle(inc); break;
      case 'regen': s.regenStep(inc); break;
      case 'reverser': s.reverserStep(inc); break;
      case 'trainBrake': s.trainBrake(inc); break;
      case 'locoBrake': s.locoBrake(inc * 0.25); break;
      case 'hornLow': s.setHorn('low', true); break;
      case 'hornHigh': s.setHorn('high', true); break;
      case 'headlight': s.cycleHeadlight(); break;
      case 'cabLight': s.toggleCabLight(); break;
      case 'markers': s.toggleMarkers(); break;
      case 'flasher': s.toggleFlasher(); break;
      case 'panto': s.togglePanto(); break;
      case 'vcb': s.toggleVcb(); break;
      case 'fuelPump': s.toggleFuelPump(); break;
      case 'engine': s.toggleEngine(); break;
      case 'wipers': s.cycleWipers(); break;
      case 'sander': s.setSander(true); break;
      case 'vigilance': s.acknowledgeVigilance(speed); break;
      case 'emergencyStop': s.emergencyButton(); break;
    }
  }
  release(id: string) {
    if (id === 'hornLow') this.sys.setHorn('low', false);
    if (id === 'hornHigh') this.sys.setHorn('high', false);
    if (id === 'sander') this.sys.setSander(false);
  }
  wheel(id: string, dy: number, speed: number) {
    if (['throttle', 'regen', 'trainBrake', 'locoBrake', 'reverser'].includes(id)) this.press(id, dy < 0 ? 0 : 2, speed);
  }

  update(dt: number, r: CabReadings, night: number) {
    const s = this.sys, b = this.brakes;
    this.blink += dt;
    const g = (id: string) => this.ctl.get(id)!.moving;
    g('throttle').rotation.z = -0.55 + (s.notch / s.loco.notches) * 1.1;
    g('regen').rotation.z = 0.5 - (s.regen / s.loco.regen.notches) * 1.0;
    g('trainBrake').rotation.y = 1.0 - (b.handle / (BRAKE_POSITIONS.length - 1)) * 2.0;
    g('locoBrake').rotation.y = 0.6 - b.independent * 1.2;
    g('reverser').rotation.y = -s.reverser * 0.7;
    const pressed = (id: string, on: boolean) => { g(id).children[0].position.y = on ? -0.008 : 0; };
    pressed('hornLow', s.hornLow); pressed('hornHigh', s.hornHigh); pressed('sander', s.sander);
    pressed('emergencyStop', s.emergencyStop);
    const tog = (id: string, on: boolean) => { g(id).rotation.z = on ? 0.45 : -0.45; };
    if (s.isDiesel) { tog('fuelPump', s.fuelPump); tog('engine', s.engine !== 'stopped'); }
    else { tog('panto', s.pantoUp); tog('vcb', s.vcb); }
    tog('markers', s.markers); tog('flasher', s.flasher); tog('cabLight', s.cabLight);
    g('headlight').rotation.y = -s.headlight * 0.7;
    g('wipers').rotation.y = -s.wipers * 0.7;

    this.faceMat.emissiveIntensity = night * 0.6 + (s.cabLight ? 0.1 : 0);
    this.gauges.speed.set([r.speedKmph], dt);
    this.gauges.bpbc.set([r.bp, r.bc], dt);
    this.gauges.mr.set([r.mr], dt);
    this.gauges.kv.set([s.isDiesel ? s.engineRpm : r.kV], dt);
    this.gauges.amps.set([r.amps], dt);
    this.gauges.te?.set([r.teKN], dt);
    const fl = Math.sin(this.blink * 8) > 0;
    const on = [r.slip, r.overspeed && fl, r.vigilance === 'penalty' || (r.vigilance === 'warning' && fl), r.brakeApplied,
      s.isDiesel ? !s.fuelPump : r.pantoDown, s.isDiesel ? s.engine !== 'running' && (s.engine === 'stopped' || fl) : r.vcbOpen];
    LAMPS.forEach((_, i) => this.lamps.set(i, on[i]));
    this.displayTimer -= dt;
    if (this.display && this.displayTimer <= 0) {
      this.displayTimer = 0.2;
      this.display.draw({ speed: r.displaySpeed, limit: r.limit, km: r.km, notch: s.notch, regen: s.regen, reverser: s.reverser, nextSignal: r.nextSignal, signalDist: r.signalDist, aspect: r.aspect, te: r.teKN, clock: r.clock, units: r.units });
    }
  }
}
