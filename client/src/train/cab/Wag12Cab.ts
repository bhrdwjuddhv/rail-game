import * as THREE from 'three/webgpu';
import { BRAKE_POSITIONS, BrakeSystem } from '@rail/shared/physics/BrakeSystem';
import type { LocoSystems } from '@rail/shared/train/LocoSystems';
import { GeoBatch, mat } from '../../core/GeoBatch';
import { Atlas, uvToRect } from '../../core/Textures';
import type { CabReadings } from './CabControls';
import { DriverDisplay, Gauge } from './Gauges';

/**
 * WAG-12B driving cab (modern twin-section freight loco), built to sit inside
 * the 3D model's own cab shell (its walls, windows and roof stay). Loco body
 * frame: +x forward, +y up from rail top, +z right. Measured from the model:
 * floor y 1.21, windscreen bottom y 2.23 at x 9.12, top y 3.22 at x 8.63,
 * glass z +-1.21, rear wall x 7.6, ceiling y 3.42.
 *
 * Layout after the real cab: a blue-grey desk; a raked instrument console
 * under the windscreen with four round gauges and a larger one on the left,
 * the driver's display unit (DDU) in the middle with rotary knobs below, a
 * small screen and coloured push buttons on the right; the combined power /
 * brake controller with its green read-out and the automatic brake handle at
 * the left, the reverser plate on the right; a cab fan on the left pillar, an
 * equipment cabinet in the right corner, a window guard of vertical bars.
 * Gauges, the DDU, levers and the reverser follow the loco. There are no
 * clickable controls: it is driven from the keyboard, gamepad or touch.
 */

const DESK = '#5b6c74', DESK_DARK = '#46555c', PANEL = '#56666e', INSET = '#2f3a40';
const FLOOR_Y = 1.21, DESK_Y = 1.98, SILL_Y = 2.22, SILL_X = 8.92, DESK_X0 = 8.12, PANEL_X0 = 8.6;

/** canvas sign (white text on dark blue) */
function sign(atlas: Atlas, w: number, h: number, lines: string[]) {
  return atlas.add(w, h, g => {
    g.fillStyle = '#16418c'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#ffffff'; g.lineWidth = 3; g.strokeRect(4, 4, w - 8, h - 8);
    g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const fs = Math.floor((h - 16) / lines.length * 0.62);
    g.font = `bold ${fs}px Arial`;
    lines.forEach((l, i) => g.fillText(l, w / 2, 8 + (h - 16) * (i + 0.5) / lines.length, w - 20));
  });
}

export class Wag12Cab {
  readonly group = new THREE.Group();
  private gauges: Record<string, Gauge> = {};
  private ddu: DriverDisplay;
  private ctl: THREE.Object3D;       // master controller handle pivot
  private ctlLcd: HTMLCanvasElement;
  private ctlTex: THREE.CanvasTexture;
  private a9: THREE.Object3D;
  private sa9: THREE.Object3D;
  private rev: THREE.Object3D;
  private fan: THREE.Object3D;
  private small: HTMLCanvasElement;
  private smallTex: THREE.CanvasTexture;
  private lcdKey = '';
  private t = 0;
  private faceMat: THREE.MeshStandardMaterial;

  constructor(private sys: LocoSystems, private brakes: BrakeSystem) {
    const atlas = new Atlas(2048, 1024); // five gauge faces, signs, labels and the timetable sheet
    this.faceMat = new THREE.MeshStandardMaterial({ map: atlas.texture, vertexColors: true, roughness: 0.5, emissive: 0xffffff, emissiveMap: atlas.texture, emissiveIntensity: 0.05 });
    const shell = new GeoBatch(), faces = new GeoBatch();
    const mats = () => ({ std: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.05 }), metal: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.5 }), faces: this.faceMat });
    const M = mats();

    // ---- floor, desk, console body, sill ------------------------------------------------
    shell.box(1.9, 0.04, 2.84, mat(8.45, FLOOR_Y - 0.02, 0), '#3d4549');
    // desk top and its front (a knee recess under the driver's side)
    shell.box(PANEL_X0 - DESK_X0 + 0.02, 0.05, 2.8, mat((DESK_X0 + PANEL_X0) / 2, DESK_Y - 0.025, 0), DESK);
    shell.box(0.05, DESK_Y - FLOOR_Y - 0.05, 1.5, mat(DESK_X0 + 0.32, (DESK_Y + FLOOR_Y) / 2 - 0.02, 0.65), DESK_DARK);
    shell.box(0.05, DESK_Y - FLOOR_Y - 0.05, 0.62, mat(DESK_X0 + 0.32, (DESK_Y + FLOOR_Y) / 2 - 0.02, -1.09), DESK_DARK);
    shell.box(0.42, 0.04, 0.95, mat(DESK_X0 + 0.55, FLOOR_Y + 0.62, -0.32), DESK_DARK); // knee recess roof
    shell.box(0.06, 0.07, 2.8, mat(DESK_X0 + 0.02, DESK_Y - 0.035, 0), '#4f5f66');   // rounded front edge
    // console body behind the raked panel, and the sill under the windscreen
    shell.box(SILL_X - PANEL_X0 + 0.22, SILL_Y - DESK_Y, 2.8, mat((PANEL_X0 + SILL_X + 0.22) / 2, (SILL_Y + DESK_Y) / 2, 0), DESK_DARK);
    shell.box(0.24, 0.04, 2.8, mat(SILL_X + 0.1, SILL_Y + 0.02, 0), DESK);

    // ---- raked instrument panel (local: x to the right, y up the panel, z toward the driver) ----
    const panel = new THREE.Object3D();
    const rake = Math.atan2(SILL_X - PANEL_X0, SILL_Y - DESK_Y); // from vertical
    const len = Math.hypot(SILL_X - PANEL_X0, SILL_Y - DESK_Y);
    panel.position.set((PANEL_X0 + SILL_X) / 2 - 0.005, (DESK_Y + SILL_Y) / 2 + 0.005, 0);
    panel.rotation.set(-rake, -Math.PI / 2, 0, 'YXZ');
    this.group.add(panel);
    const pFaces = new GeoBatch(), pStatic = new GeoBatch();
    pStatic.box(2.8, len + 0.02, 0.012, mat(0, 0, -0.006), PANEL);
    pStatic.box(1.0, len - 0.03, 0.006, mat(-0.12, 0, 0.002), INSET);   // centre screens inset
    pStatic.box(0.5, len - 0.05, 0.006, mat(0.66, 0, 0.002), '#45535a'); // right button panel
    const h = len / 2;
    const addG = (id: string, x: number, y: number, label: string, min: number, max: number, unit: string, r: number, o: ConstructorParameters<typeof Gauge>[11] = {}) => {
      this.gauges[id] = new Gauge(atlas, pFaces, pStatic, panel, x, y, label, min, max, unit, r, o);
    };
    // left: four gauges in a row, a larger one below
    addG('mr', -1.24, h * 0.42, 'MR', 0, 12, 'kg/cm²', 0.042, { majors: 6 });
    addG('bpbc', -1.12, h * 0.42, 'BP / BC', 0, 10, 'kg/cm²', 0.042, { majors: 5, needles: ['BP', 'BC'] });
    addG('er', -1.00, h * 0.42, 'ER', 0, 10, 'kg/cm²', 0.042, { majors: 5 });
    addG('kv', -0.86, h * 0.36, 'OHE', 0, 32, 'kV', 0.055, { majors: 8, redFrom: 29 });
    addG('te', -1.12, -h * 0.5, 'TE', 0, 600, 'kN', 0.058, { majors: 6 });
    // speaker grille and a blank switch plate, the small traction display below
    pStatic.box(0.085, 0.085, 0.01, mat(-0.52, h * 0.45, 0.006), '#151a1d');
    pStatic.add(new THREE.TorusGeometry(0.028, 0.006, 6, 20), mat(-0.52, h * 0.45, 0.012), '#3a4247', 'metal');
    pStatic.box(0.085, 0.085, 0.01, mat(-0.40, h * 0.45, 0.006), '#0f1214');
    this.small = document.createElement('canvas'); this.small.width = 256; this.small.height = 128;
    this.smallTex = new THREE.CanvasTexture(this.small); this.smallTex.colorSpace = THREE.SRGBColorSpace;
    const smallScreen = new THREE.Mesh(new THREE.PlaneGeometry(0.15, 0.075), new THREE.MeshBasicMaterial({ map: this.smallTex }));
    smallScreen.position.set(-0.46, -h * 0.4, 0.01);
    panel.add(smallScreen);
    pStatic.box(0.17, 0.095, 0.008, mat(-0.46, -h * 0.4, 0.004), '#101315');
    // the DDU (driver's display unit) and five rotary knobs below it
    this.ddu = new DriverDisplay(0.24, 0.15);
    this.ddu.mesh.position.set(0.0, h * 0.18, 0.012);
    panel.add(this.ddu.mesh);
    pStatic.box(0.27, 0.18, 0.012, mat(0.0, h * 0.18, 0.005), '#0c0f11');
    for (let i = 0; i < 5; i++) {
      pStatic.add(new THREE.CylinderGeometry(0.016, 0.018, 0.022, 14).rotateX(Math.PI / 2), mat(-0.13 + i * 0.065, -h * 0.68, 0.016), '#111111', 'metal');
      pStatic.box(0.004, 0.012, 0.004, mat(-0.13 + i * 0.065, -h * 0.68 + 0.01, 0.028), '#d8d8d8');
    }
    // right panel: small LCD, coloured push buttons, black switches
    pStatic.box(0.09, 0.065, 0.01, mat(0.62, h * 0.3, 0.006), '#c9ccc7');
    const lcd = atlas.add(128, 96, g => { g.fillStyle = '#9fb9a8'; g.fillRect(0, 0, 128, 96); g.fillStyle = '#1d2a22'; g.font = 'bold 30px monospace'; g.textAlign = 'center'; g.fillText('MR 9.0', 64, 44); g.font = '18px monospace'; g.fillText('BRK OK', 64, 76); });
    pFaces.add(uvToRect(new THREE.PlaneGeometry(0.072, 0.05), lcd), mat(0.62, h * 0.3, 0.012), '#ffffff', 'faces');
    const btn = (x: number, y: number, c: string) => {
      pStatic.add(new THREE.CylinderGeometry(0.019, 0.019, 0.01, 16).rotateX(Math.PI / 2), mat(x, y, 0.004), '#cfcfcf', 'metal');
      pStatic.add(new THREE.CylinderGeometry(0.014, 0.014, 0.016, 16).rotateX(Math.PI / 2), mat(x, y, 0.01), c);
    };
    btn(0.48, h * 0.35, '#c81f1f'); btn(0.78, h * 0.35, '#1f5fc8');
    btn(0.47, -h * 0.45, '#e8c21c'); btn(0.55, -h * 0.45, '#c81f1f'); btn(0.63, -h * 0.45, '#e8c21c'); btn(0.71, -h * 0.45, '#c81f1f');
    for (const [x, y] of [[0.48, -h * 0.02], [0.80, h * 0.02], [0.82, -h * 0.4]] as const) {
      pStatic.add(new THREE.CylinderGeometry(0.014, 0.016, 0.02, 12).rotateX(Math.PI / 2), mat(x, y, 0.012), '#141414', 'metal');
    }
    const lab = atlas.add(512, 40, g => { g.fillStyle = '#45535a'; g.fillRect(0, 0, 512, 40); g.fillStyle = '#e6e6e6'; g.font = '16px Arial'; g.textAlign = 'center'; ['RESET', 'BRAKE TEST', 'CAB LIGHT', 'HEAD LIGHT'].forEach((t, i) => g.fillText(t, 64 + i * 128, 26)); });
    pFaces.add(uvToRect(new THREE.PlaneGeometry(0.34, 0.026), lab), mat(0.59, -h * 0.78, 0.006), '#ffffff', 'faces');
    panel.add(pFaces.build(M, false), pStatic.build(M, false));

    // ---- master controller (combined power / dynamic brake), green read-out ----------------
    const cx = DESK_X0 + 0.24, cz = -0.62;
    shell.box(0.3, 0.1, 0.24, mat(cx, DESK_Y + 0.05, cz), '#1b1f22', 'metal');
    shell.box(0.12, 0.13, 0.2, mat(cx + 0.06, DESK_Y + 0.165, cz + 0.02), '#22272a', 'metal');
    this.ctlLcd = document.createElement('canvas'); this.ctlLcd.width = 256; this.ctlLcd.height = 96;
    this.ctlTex = new THREE.CanvasTexture(this.ctlLcd); this.ctlTex.colorSpace = THREE.SRGBColorSpace;
    const lcdMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.15, 0.055), new THREE.MeshBasicMaterial({ map: this.ctlTex }));
    lcdMesh.position.set(cx - 0.002, DESK_Y + 0.17, cz + 0.02);
    lcdMesh.rotation.set(0, -Math.PI / 2, 0);
    lcdMesh.rotateX(-0.25);
    this.group.add(lcdMesh);
    this.ctl = new THREE.Object3D();
    this.ctl.position.set(cx - 0.02, DESK_Y + 0.1, cz - 0.17);
    const handle = new GeoBatch();
    handle.box(0.03, 0.16, 0.03, mat(0, 0.08, 0), '#2a2d30', 'metal');
    handle.cyl(0.022, 0.022, 0.2, 14, mat(0, 0.17, 0.05, 0, Math.PI / 2), '#b9bdc0', 'metal');
    this.ctl.add(handle.build(M, false));
    this.group.add(this.ctl);
    // automatic (A9) and independent (SA9) brake handles at the far left
    const lever = (x: number, z: number, len: number, knob: string) => {
      shell.cyl(0.05, 0.06, 0.04, 16, mat(x, DESK_Y + 0.02, z), '#16191b', 'metal');
      const o = new THREE.Object3D();
      o.position.set(x, DESK_Y + 0.05, z);
      const b = new GeoBatch();
      b.cyl(0.012, 0.012, len, 8, mat(len / 2, 0.03, 0, 0, 0, Math.PI / 2), '#2a2a2a', 'metal');
      b.add(new THREE.SphereGeometry(0.028, 12, 10), mat(len, 0.035, 0), knob, 'metal');
      o.add(b.build(M, false));
      this.group.add(o);
      return o;
    };
    this.a9 = lever(DESK_X0 + 0.22, -1.18, 0.16, '#151515');
    this.sa9 = lever(DESK_X0 + 0.34, -0.98, 0.12, '#151515');
    // reverser plate and handle on the right of the desk
    const rx = DESK_X0 + 0.25, rz = 0.42;
    shell.box(0.26, 0.012, 0.3, mat(rx, DESK_Y + 0.006, rz), '#141719');
    const revLab = atlas.add(256, 256, g => {
      g.fillStyle = '#141719'; g.fillRect(0, 0, 256, 256); g.fillStyle = '#e6e6e6'; g.font = 'bold 22px Arial';
      g.fillText('FORWARD', 120, 50); g.fillText('NEUTRAL', 120, 130); g.fillText('REVERSE', 120, 210);
      g.strokeStyle = '#e6e6e6'; g.lineWidth = 3; g.beginPath(); g.moveTo(60, 40); g.lineTo(60, 220); g.stroke();
    });
    faces.add(uvToRect(new THREE.PlaneGeometry(0.24, 0.24), revLab), mat(rx, DESK_Y + 0.014, rz, Math.PI / 2, -Math.PI / 2), '#ffffff', 'faces');
    this.rev = new THREE.Object3D();
    this.rev.position.set(rx, DESK_Y + 0.015, rz - 0.07);
    const rb = new GeoBatch();
    rb.cyl(0.012, 0.014, 0.12, 8, mat(0, 0.06, 0), '#202020', 'metal');
    rb.cyl(0.02, 0.016, 0.06, 10, mat(0, 0.14, 0), '#0e0e0e', 'metal');
    this.rev.add(rb.build(M, false));
    this.group.add(this.rev);

    // ---- desk clutter: the working timetable on a clipboard ---------------------------------
    const paper = atlas.add(256, 320, g => {
      g.fillStyle = '#f4f3ee'; g.fillRect(0, 0, 256, 320);
      g.fillStyle = '#6b6b6b'; g.font = 'bold 14px Arial'; g.fillText('WORKING TIMETABLE', 50, 26);
      g.strokeStyle = '#9a9a9a';
      for (let y = 44; y < 300; y += 11) { g.beginPath(); g.moveTo(14, y); g.lineTo(242, y); g.stroke(); }
      for (const x of [60, 120, 180]) { g.beginPath(); g.moveTo(x, 40); g.lineTo(x, 300); g.stroke(); }
    });
    faces.add(uvToRect(new THREE.PlaneGeometry(0.21, 0.27), paper), mat(DESK_X0 + 0.24, DESK_Y + 0.004, -0.06, Math.PI / 2 + 0.06, -Math.PI / 2), '#ffffff', 'faces');
    shell.box(0.2, 0.008, 0.06, mat(DESK_X0 + 0.37, DESK_Y + 0.006, -0.06), '#9aa0a3', 'metal');

    // ---- cab fan on the left pillar ---------------------------------------------------------
    const fanBase = new THREE.Object3D();
    fanBase.position.set(8.55, 2.95, -1.18);
    fanBase.rotation.set(0, -Math.PI / 2 + 0.6, -0.15);
    const fb = new GeoBatch();
    fb.add(new THREE.TorusGeometry(0.16, 0.008, 6, 32), mat(0, 0, 0.02), '#1a1a1a', 'metal');
    fb.add(new THREE.TorusGeometry(0.16, 0.008, 6, 32), mat(0, 0, -0.06), '#1a1a1a', 'metal');
    for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; fb.box(0.004, 0.32, 0.004, mat(0, 0, 0.02, 0, 0, a), '#222222', 'metal'); }
    fb.cyl(0.05, 0.05, 0.1, 14, mat(0, 0, -0.1, 0, Math.PI / 2), '#202020', 'metal');
    fb.box(0.04, 0.2, 0.04, mat(0, -0.12, -0.14), '#1c1c1c', 'metal');
    fanBase.add(fb.build(M, false));
    this.fan = new THREE.Object3D();
    const blades = new GeoBatch();
    for (let i = 0; i < 4; i++) blades.box(0.05, 0.13, 0.004, mat(0, 0.07, 0).premultiply(new THREE.Matrix4().makeRotationZ((i / 4) * Math.PI * 2)), '#2b2e31', 'metal');
    this.fan.add(blades.build(M, false));
    this.fan.position.set(0, 0, -0.02);
    fanBase.add(this.fan);
    this.group.add(fanBase);

    // ---- equipment cabinet in the right front corner, cab signs -----------------------------
    shell.box(0.5, 1.12, 0.36, mat(8.72, SILL_Y + 0.56, 1.22), '#d6d8d5');
    for (let i = 0; i < 9; i++) shell.box(0.005, 0.012, 0.12, mat(8.465, SILL_Y + 0.35 + i * 0.045, 1.33), '#3d4245');
    const s1 = sign(atlas, 512, 128, ['CABIN LIGHTS MUST BE SWITCHED OFF', 'WHILE THE LOCOMOTIVE IS MOVING']);
    faces.add(uvToRect(new THREE.PlaneGeometry(0.2, 0.05), s1), mat(8.466, SILL_Y + 0.1, 1.2, -Math.PI / 2), '#ffffff', 'faces');
    const s2 = sign(atlas, 512, 192, ['ALL DOORS AND WINDOWS', 'MUST BE KEPT CLOSED', 'DURING OPERATION']);
    faces.add(uvToRect(new THREE.PlaneGeometry(0.2, 0.075), s2), mat(8.466, SILL_Y + 0.92, 1.2, -Math.PI / 2), '#ffffff', 'faces');
    const s3 = sign(atlas, 512, 128, ['CLOSE THE MIRROR BEFORE MOVING', 'THE DEAD LOCOMOTIVE']);
    faces.add(uvToRect(new THREE.PlaneGeometry(0.24, 0.06), s3), mat(8.3, 2.66, -1.39, 0), '#ffffff', 'faces');

    // ---- window guard: vertical bars outside the windscreen, slats along the top -----------
    const bars = new GeoBatch();
    const bx0 = 9.14, by0 = 2.23, bx1 = 8.65, by1 = 3.22;
    const barLen = Math.hypot(bx0 - bx1, by1 - by0), tilt = Math.atan2(bx0 - bx1, by1 - by0);
    for (let z = -1.15; z <= 1.15 + 1e-6; z += 0.075) bars.box(0.008, barLen, 0.008, mat((bx0 + bx1) / 2 + 0.035, (by0 + by1) / 2, z, 0, 0, tilt), '#2b2f32', 'metal');
    for (const y of [by0 + 0.02, by1 - 0.03]) bars.box(0.012, 0.02, 2.36, mat(bx0 + 0.035 - (y - by0) * Math.tan(tilt), y, 0), '#2b2f32', 'metal');
    for (let k = 0; k < 4; k++) { const y = by1 - 0.06 - k * 0.025; bars.box(0.006, 0.006, 2.3, mat(bx0 + 0.035 - (y - by0) * Math.tan(tilt), y, 0), '#3a3f42', 'metal'); }

    this.group.add(shell.build(M), faces.build(M, false), bars.build(M, false));
    this.group.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = false; m.receiveShadow = true; } });
  }

  update(dt: number, r: CabReadings, night: number) {
    const s = this.sys, b = this.brakes;
    this.t += dt;
    this.faceMat.emissiveIntensity = 0.05 + night * 0.5;
    this.gauges.mr.set([r.mr], dt);
    this.gauges.bpbc.set([r.bp, r.bc], dt);
    this.gauges.er.set([r.er], dt);
    this.gauges.kv.set([r.kV], dt);
    this.gauges.te.set([r.teKN], dt);
    this.ddu.draw({ speed: r.displaySpeed, limit: r.limit, km: r.km, notch: s.notch, regen: s.regen, reverser: s.reverser, nextSignal: r.nextSignal, signalDist: r.signalDist, aspect: r.aspect, te: r.teKN, clock: r.clock, units: r.units });
    // master controller: forward for power, back for dynamic brake
    const power = s.notch / s.loco.notches, dyn = s.regen / s.loco.regen.notches;
    this.ctl.rotation.z = -0.55 * power + 0.5 * dyn;
    this.a9.rotation.y = 0.9 - (b.handle / (BRAKE_POSITIONS.length - 1)) * 1.8;
    this.sa9.rotation.y = 0.5 - b.independent * 1.0;
    this.rev.position.x = 8.37 + (s.reverser > 0 ? 0.08 : s.reverser < 0 ? -0.08 : 0);
    this.fan.rotation.z -= dt * 22;
    // read-outs: the controller shows its step, the small screen tractive effort bars
    const key = `${s.notch}|${s.regen}|${Math.round(r.teKN / 20)}`;
    if (key !== this.lcdKey) {
      this.lcdKey = key;
      const g = this.ctlLcd.getContext('2d')!;
      g.fillStyle = '#8fe34a'; g.fillRect(0, 0, 256, 96);
      g.fillStyle = '#0e2a0a'; g.font = 'bold 44px monospace'; g.textAlign = 'center';
      g.fillText(s.regen > 0 ? `DB ${s.regen}` : s.notch > 0 ? `TE ${s.notch}` : 'IDLE', 128, 62);
      this.ctlTex.needsUpdate = true;
      const q = this.small.getContext('2d')!;
      q.fillStyle = '#0a0d10'; q.fillRect(0, 0, 256, 128);
      const te = Math.min(1, r.teKN / 600);
      for (const [x, v, c] of [[70, te, '#3ce07a'], [150, dyn, '#e0c33c']] as const) {
        q.fillStyle = '#1d262c'; q.fillRect(x, 14, 36, 100);
        q.fillStyle = c; q.fillRect(x, 114 - v * 100, 36, v * 100);
      }
      this.smallTex.needsUpdate = true;
    }
  }
}
