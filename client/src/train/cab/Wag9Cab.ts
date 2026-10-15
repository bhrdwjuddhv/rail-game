import * as THREE from 'three/webgpu';
import { BRAKE_POSITIONS, BrakeSystem } from '@rail/shared/physics/BrakeSystem';
import type { LocoSystems } from '@rail/shared/train/LocoSystems';
import { GeoBatch, mat } from '../../core/GeoBatch';
import { Atlas, uvToRect } from '../../core/Textures';
import type { CabReadings } from './CabControls';
import { Gauge, LampPanel } from './Gauges';

/**
 * WAG-9 driving cab, after a photograph of the real one. The 3D model has no
 * interior, so this is the whole room (the model is not drawn from the seat):
 * floor, walls, roof, two windscreens with rounded corners (guards of
 * vertical bars on both, a wiper on the driver's), side windows, a door behind.
 * Loco body frame: +x forward, +y up from rail top, +z right; the driver sits
 * on the left (z -0.55).
 *
 * The desk, left to right: four pressure gauges in a grey block; a black
 * panel with the line voltmeter (UBA), the U / BOGIE1 / BOGIE2 bar meters,
 * the LSDJ LSHO LSP LSAF LSVW LSCE lamps, push buttons, the emergency mushroom
 * and the ZPT ... ZTEL switches; the driver's display (DDU) with its button
 * field; the speedometer box on the pillar to the right of the windscreen. On
 * the desk the TE / BE controller (WOAMA), the loco brake joystick and the
 * automatic brake handle at the left with its quadrant plate. Every screen,
 * meter, lamp, needle and lever follows the loco. Driven from the keyboard,
 * gamepad or touch (no clickable controls).
 */

const FLOOR_Y = 1.75, CEIL_Y = 3.72, REAR_X = 7.3, FRONT_X = 9.3, HW = 1.36;
const DESK_Y = 2.45, DESK_X0 = 8.6, PANEL_X0 = 9.02, SILL_X = 9.14, SILL_Y = 2.76, WIN_Y0 = 2.82, WIN_Y1 = 3.48;
const WALL = '#d9d8cf', WALL_DARK = '#c3c2b8', DESK = '#a9adab', BLACK = '#17191b', GREY_FRAME = '#8f9493';
/** windscreens (z ranges): the driver's on the left, the assistant's on the right */
const WINDOWS: [number, number][] = [[-1.24, -0.1], [0.1, 1.24]];

function roundRect(p: THREE.Path, x0: number, y0: number, x1: number, y1: number, r: number) {
  p.moveTo(x0 + r, y0);
  p.lineTo(x1 - r, y0); p.absarc(x1 - r, y0 + r, r, -Math.PI / 2, 0, false);
  p.lineTo(x1, y1 - r); p.absarc(x1 - r, y1 - r, r, 0, Math.PI / 2, false);
  p.lineTo(x0 + r, y1); p.absarc(x0 + r, y1 - r, r, Math.PI / 2, Math.PI, false);
  p.lineTo(x0, y0 + r); p.absarc(x0 + r, y0 + r, r, Math.PI, Math.PI * 1.5, false);
}

/** A wall: the rectangle [x0, x1] x [y0, y1] in its own plane, with rounded window holes. */
function wall(x0: number, y0: number, x1: number, y1: number, holes: [number, number, number, number][], r = 0.09) {
  const s = new THREE.Shape();
  s.moveTo(x0, y0); s.lineTo(x1, y0); s.lineTo(x1, y1); s.lineTo(x0, y1); s.lineTo(x0, y0);
  for (const h of holes) { const p = new THREE.Path(); roundRect(p, h[0], h[1], h[2], h[3], r); s.holes.push(p); }
  return new THREE.ShapeGeometry(s, 6);
}

/** label in the atlas: light text on dark (panel lettering) or dark on light (signs) */
function label(atlas: Atlas, w: number, h: number, text: string, opts: { bg?: string; fg?: string; size?: number; bold?: boolean } = {}) {
  return atlas.add(w, h, g => {
    g.fillStyle = opts.bg ?? '#17191b'; g.fillRect(0, 0, w, h);
    g.fillStyle = opts.fg ?? '#e8e8e8'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `${opts.bold === false ? '' : 'bold '}${opts.size ?? Math.floor(h * 0.62)}px Arial`;
    g.fillText(text, w / 2, h / 2 + 1, w - 6);
  });
}

/** A canvas screen on a plane, redrawn when its key changes. */
class Screen {
  readonly canvas = document.createElement('canvas');
  readonly tex: THREE.CanvasTexture;
  readonly mesh: THREE.Mesh;
  key = '';
  constructor(w: number, h: number, px: number, py: number) {
    this.canvas.width = px; this.canvas.height = py;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: this.tex, toneMapped: false }));
  }
  draw(key: string, fn: (g: CanvasRenderingContext2D, w: number, h: number) => void) {
    if (key === this.key) return;
    this.key = key;
    fn(this.canvas.getContext('2d')!, this.canvas.width, this.canvas.height);
    this.tex.needsUpdate = true;
  }
}

export class Wag9Cab {
  readonly group = new THREE.Group();
  private gauges: Record<string, Gauge> = {};
  private lamps: LampPanel;
  private ddu: Screen;
  private bars: Screen;
  private speedo: Screen;
  private ctl: THREE.Object3D;
  private a9: THREE.Object3D;
  private sa9: THREE.Object3D;
  private wiper: THREE.Object3D;
  private faceMat: THREE.MeshStandardMaterial;
  private lampMat: THREE.MeshBasicMaterial;
  private t = 0;
  private acc = 0;
  private wipe = 0;

  constructor(private sys: LocoSystems, private brakes: BrakeSystem) {
    const atlas = new Atlas(2048, 1024);
    this.faceMat = new THREE.MeshStandardMaterial({ map: atlas.texture, vertexColors: true, roughness: 0.5, emissive: 0xffffff, emissiveMap: atlas.texture, emissiveIntensity: 0.06 });
    const M = {
      std: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.02 }),
      metal: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.5 }),
      faces: this.faceMat,
    };
    const shell = new GeoBatch(), faces = new GeoBatch();

    // ---- the room -----------------------------------------------------------------------------
    const wallMat = new THREE.MeshStandardMaterial({ color: WALL, roughness: 0.85, side: THREE.DoubleSide });
    // front wall (its plane at FRONT_X, facing the driver), two windscreens
    const front = new THREE.Mesh(wall(-HW, FLOOR_Y, HW, CEIL_Y, WINDOWS.map(([a, b]) => [a, WIN_Y0, b, WIN_Y1])), wallMat);
    front.rotation.y = -Math.PI / 2;
    front.position.x = FRONT_X;
    // side walls with a sliding window each, near the front
    const side = (z: number) => {
      const m = new THREE.Mesh(wall(REAR_X, FLOOR_Y, FRONT_X, CEIL_Y, [[8.25, 2.62, 9.0, 3.36]], 0.06), wallMat);
      m.position.z = z;
      return m;
    };
    const rear = new THREE.Mesh(wall(-HW, FLOOR_Y, HW, CEIL_Y, []), new THREE.MeshStandardMaterial({ color: WALL_DARK, roughness: 0.85, side: THREE.DoubleSide }));
    rear.rotation.y = -Math.PI / 2;
    rear.position.x = REAR_X;
    this.group.add(front, side(-HW), side(HW), rear);
    shell.box(FRONT_X - REAR_X, 0.04, HW * 2, mat((FRONT_X + REAR_X) / 2, FLOOR_Y - 0.02, 0), '#5f6460');                 // floor
    shell.box(FRONT_X - REAR_X, 0.03, HW * 2, mat((FRONT_X + REAR_X) / 2, CEIL_Y + 0.015, 0), '#e6e5dd');                 // roof
    shell.box(0.5, 0.025, 0.24, mat(8.2, CEIL_Y - 0.012, -0.3), '#fbfaf2');                                                  // cab lamp
    shell.box(0.06, 0.12, HW * 2, mat(FRONT_X - 0.05, CEIL_Y - 0.06, 0), WALL_DARK);                                         // roof edge over the windscreens
    shell.box(0.03, 1.95, 0.8, mat(REAR_X + 0.02, FLOOR_Y + 0.98, 0.45), '#bdbcb2');                                         // door to the engine room
    shell.box(0.02, 0.04, 0.16, mat(REAR_X + 0.045, FLOOR_Y + 1.0, 0.18), '#6d7072', 'metal');                               // its handle
    // window frames: a dark rubber band round each windscreen opening
    for (const [a, b] of WINDOWS) {
      shell.box(0.04, 0.03, b - a, mat(FRONT_X - 0.02, WIN_Y0 - 0.015, (a + b) / 2), '#3b3d3e');
      shell.box(0.04, 0.03, b - a, mat(FRONT_X - 0.02, WIN_Y1 + 0.015, (a + b) / 2), '#3b3d3e');
    }
    // sun blind rolled up above the driver's windscreen
    shell.box(0.09, 0.07, 1.05, mat(FRONT_X - 0.07, WIN_Y1 + 0.09, -0.67), '#4a4d4f');

    // ---- desk -----------------------------------------------------------------------------------
    shell.box(PANEL_X0 - DESK_X0 + 0.02, 0.04, HW * 2 - 0.02, mat((DESK_X0 + PANEL_X0) / 2, DESK_Y - 0.02, 0), DESK);
    shell.box(0.05, DESK_Y - FLOOR_Y - 0.04, HW * 2 - 0.02, mat(DESK_X0 + 0.28, (DESK_Y + FLOOR_Y) / 2 - 0.02, 0), '#9a9e9c'); // desk front
    shell.box(0.05, 0.05, HW * 2 - 0.02, mat(DESK_X0, DESK_Y - 0.025, 0), '#b6bab8');                                         // rounded edge
    shell.box(SILL_X - PANEL_X0 + 0.2, 0.03, HW * 2 - 0.02, mat((SILL_X + FRONT_X) / 2, SILL_Y + 0.015, 0), DESK);           // window sill
    shell.box(0.2, SILL_Y - DESK_Y, HW * 2 - 0.02, mat(SILL_X + 0.08, (SILL_Y + DESK_Y) / 2, 0), '#7f8382');               // console body

    // ---- the raked instrument panel (local: x to the right, y up the panel, z toward the driver) ----
    const panel = new THREE.Object3D();
    const rake = Math.atan2(SILL_X - PANEL_X0, SILL_Y - DESK_Y), len = Math.hypot(SILL_X - PANEL_X0, SILL_Y - DESK_Y), h = len / 2;
    panel.position.set((PANEL_X0 + SILL_X) / 2 - 0.004, (DESK_Y + SILL_Y) / 2 + 0.004, 0);
    panel.rotation.set(-rake, -Math.PI / 2, 0, 'YXZ');
    this.group.add(panel);
    const pFaces = new GeoBatch(), pStatic = new GeoBatch();
    pStatic.box(HW * 2 - 0.04, len + 0.02, 0.012, mat(0, 0, -0.012), GREY_FRAME);   // grey console face
    // left: four gauges on a black plate in the grey block
    pStatic.box(0.42, len - 0.03, 0.008, mat(-1.06, 0, -0.008), '#2a2c2e'); // its front 4 mm behind the dial faces
    const gx = [-1.16, -0.96], gy = [h * 0.45, -h * 0.42];
    const addG = (id: string, x: number, y: number, lbl: string, min: number, max: number, unit: string, o: ConstructorParameters<typeof Gauge>[11] = {}) => {
      pStatic.box(0.17, 0.15, 0.002, mat(x, y, -0.002), '#111315'); // just behind the dial face (at 0)
      this.gauges[id] = new Gauge(atlas, pFaces, pStatic, panel, x, y + 0.002, lbl, min, max, unit, 0.062, o);
    };
    addG('bpbc', gx[0], gy[0], 'BP / BC', 0, 10, 'kg/cm²', { majors: 5, needles: ['BP', 'BC'] });
    addG('mr', gx[1], gy[0], 'MR', 0, 12, 'kg/cm²', { majors: 6 });
    addG('er', gx[0], gy[1], 'ER', 0, 10, 'kg/cm²', { majors: 5 });
    addG('fp', gx[1], gy[1], 'FP', 0, 12, 'kg/cm²', { majors: 6 });
    // centre: the black switch panel
    pStatic.box(0.62, len - 0.02, 0.008, mat(-0.5, 0, -0.008), BLACK);
    // UBA (line voltmeter): a small square analogue meter, white face
    pStatic.box(0.075, 0.07, 0.002, mat(-0.75, h * 0.55, -0.002), '#d7d9d6');
    this.gauges.uba = new Gauge(atlas, pFaces, pStatic, panel, -0.75, h * 0.53, 'UBA', 0, 32, 'kV', 0.03, { majors: 4, redFrom: 29 });
    pFaces.add(uvToRect(new THREE.PlaneGeometry(0.06, 0.016), label(atlas, 96, 26, 'UBA')), mat(-0.75, h * 0.08, 0.002), '#ffffff', 'faces');
    // the three bar meters U, BOGIE1, BOGIE2 share one live canvas
    this.bars = new Screen(0.2, 0.085, 256, 110);
    this.bars.mesh.position.set(-0.58, h * 0.52, 0.004);
    panel.add(this.bars.mesh);
    pStatic.box(0.215, 0.1, 0.006, mat(-0.58, h * 0.52, 0.0), '#0b0c0d');
    for (const [x, t] of [[-0.645, 'U'], [-0.58, 'BOGIE1'], [-0.515, 'BOGIE2']] as const) pFaces.add(uvToRect(new THREE.PlaneGeometry(0.06, 0.015), label(atlas, 96, 24, t)), mat(x, h * 0.08, 0.002), '#ffffff', 'faces');
    // warning lamps (live), with their names below them
    this.lamps = new LampPanel(atlas, pFaces, [
      { label: 'LSDJ', color: 0xff3020, x: -0.43, y: h * 0.62 }, { label: 'LSHO', color: 0xffd21e, x: -0.37, y: h * 0.62 },
      { label: 'LSP', color: 0xffd21e, x: -0.31, y: h * 0.62 }, { label: 'LSAF', color: 0xff3020, x: -0.25, y: h * 0.62 },
      { label: 'LSVW', color: 0xffd21e, x: -0.25, y: h * 0.12 }, { label: 'LSCE', color: 0xffd21e, x: -0.76, y: -h * 0.45 },
    ]);
    this.lamps.mesh.position.z = 0.004;
    this.lampMat = this.lamps.mesh.material as THREE.MeshBasicMaterial;
    panel.add(this.lamps.mesh);
    // push buttons (white, pink, cream) and the emergency mushroom (red, yellow ring)
    const btn = (x: number, y: number, c: string, r = 0.016) => {
      pStatic.add(new THREE.CylinderGeometry(r + 0.006, r + 0.006, 0.008, 18).rotateX(Math.PI / 2), mat(x, y, 0.004), '#b9bcbc', 'metal');
      pStatic.add(new THREE.CylinderGeometry(r, r, 0.016, 18).rotateX(Math.PI / 2), mat(x, y, 0.012), c);
    };
    for (const [x, c, t] of [[-0.43, '#efefea', 'BPCS'], [-0.37, '#e8a8c0', 'BPPB'], [-0.31, '#efe6c8', 'BPVR']] as const) {
      btn(x, -h * 0.12, c);
      pFaces.add(uvToRect(new THREE.PlaneGeometry(0.05, 0.013), label(atlas, 96, 24, t)), mat(x, -h * 0.4, 0.002), '#ffffff', 'faces');
    }
    pStatic.add(new THREE.CylinderGeometry(0.034, 0.034, 0.008, 22).rotateX(Math.PI / 2), mat(-0.24, -h * 0.2, 0.004), '#f0c419');
    pStatic.add(new THREE.SphereGeometry(0.026, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2), mat(-0.24, -h * 0.2, 0.012), '#d01414');
    // the ZPT ... ZTEL toggle switches and the BL key switch
    for (const [i, t] of ['ZPT', 'BLDJ', 'BLCP', 'BLHO', 'ZTEL'].entries()) {
      const x = -0.64 + i * 0.065;
      pStatic.box(0.022, 0.03, 0.006, mat(x, -h * 0.55, 0.003), '#2c2e30', 'metal');
      pStatic.box(0.006, 0.006, 0.03, mat(x, -h * 0.5, 0.018), '#c9c9c9', 'metal');
      pFaces.add(uvToRect(new THREE.PlaneGeometry(0.05, 0.012), label(atlas, 96, 22, t)), mat(x, -h * 0.82, 0.002), '#ffffff', 'faces');
    }
    btn(-0.76, -h * 0.05, '#e8c21c', 0.013);
    pFaces.add(uvToRect(new THREE.PlaneGeometry(0.05, 0.012), label(atlas, 96, 22, 'BL')), mat(-0.7, -h * 0.82, 0.002), '#ffffff', 'faces');
    pStatic.add(new THREE.CylinderGeometry(0.012, 0.012, 0.02, 12).rotateX(Math.PI / 2), mat(-0.7, -h * 0.5, 0.01), '#c79a2a', 'metal');
    // the DDU: a live screen in a black bezel, with a button field to its right
    pStatic.box(0.86, len - 0.02, 0.008, mat(0.33, 0, -0.008), BLACK);
    this.ddu = new Screen(0.29, 0.19, 640, 420);
    this.ddu.mesh.position.set(0.08, 0.0, 0.006);
    panel.add(this.ddu.mesh);
    pStatic.box(0.31, 0.21, 0.01, mat(0.08, 0, 0.0), '#0a0b0c');
    for (let r = 0; r < 4; r++) for (let c = 0; c < 6; c++) {
      if (r === 3 && c > 3) continue;
      const x = 0.3 + c * 0.055, y = h * 0.62 - r * h * 0.4;
      pStatic.add(new THREE.CylinderGeometry(0.011, 0.011, 0.01, 12).rotateX(Math.PI / 2), mat(x, y, 0.006), '#3a3d40', 'metal');
      pStatic.add(new THREE.CylinderGeometry(0.008, 0.008, 0.014, 12).rotateX(Math.PI / 2), mat(x, y, 0.01), '#1c1e20');
    }
    btn(0.52, -h * 0.62, '#c81f1f', 0.018);
    btn(0.6, -h * 0.62, '#ecebdf', 0.022);
    panel.add(pFaces.build(M, false), pStatic.build(M, false));
    // "Cab-2" chalked on the frame above the panel
    faces.add(uvToRect(new THREE.PlaneGeometry(0.1, 0.03), label(atlas, 128, 40, 'Cab-2', { bg: '#a9adab', fg: '#20262c', bold: false })), mat(SILL_X + 0.006, SILL_Y - 0.03, -0.62, -Math.PI / 2, -0.35), '#ffffff', 'faces');

    // ---- speedometer box on the pillar right of the driver's windscreen --------------------------
    const sp = new THREE.Object3D();
    // standing on the console top in front of the right windscreen, its back well clear of the glass
    sp.position.set(FRONT_X - 0.34, SILL_Y + 0.25, 0.42);
    sp.rotation.set(0, -Math.PI / 2 - 0.45, 0); // its dial turned toward the driver (left)
    const spb = new GeoBatch();
    spb.box(0.32, 0.44, 0.22, mat(0, 0, -0.11), '#c7c9c6');
    spb.box(0.27, 0.39, 0.01, mat(0, 0, 0.002), '#2b2e30');
    for (let r = 0; r < 4; r++) for (let c = 0; c < 6; c++) spb.box(0.026, 0.016, 0.008, mat(-0.085 + c * 0.034, -0.12 - r * 0.022, 0.008), '#55595c', 'metal');
    sp.add(spb.build(M, false));
    this.speedo = new Screen(0.21, 0.24, 300, 340);
    this.speedo.mesh.position.set(0, 0.06, 0.009);
    sp.add(this.speedo.mesh);
    this.group.add(sp);
    // "MAX SPEED 100 KMPH" sign above it
    faces.add(uvToRect(new THREE.PlaneGeometry(0.3, 0.1), atlas.add(384, 128, g => {
      g.fillStyle = '#f4f3ee'; g.fillRect(0, 0, 384, 128); g.strokeStyle = '#b01515'; g.lineWidth = 6; g.strokeRect(6, 6, 372, 116);
      g.fillStyle = '#b01515'; g.textAlign = 'center'; g.font = 'bold 34px Arial'; g.fillText('MAX SPEED', 192, 54); g.font = 'bold 40px Arial'; g.fillText('100 KMPH', 192, 102);
    })), mat(FRONT_X - 0.01, 3.6, 0.55, -Math.PI / 2), '#ffffff', 'faces');

    // ---- on the desk: TE / BE controller, loco brake joystick, automatic brake handle --------------
    const cx = DESK_X0 + 0.25, cz = 0.12;
    shell.box(0.3, 0.012, 0.13, mat(cx, DESK_Y + 0.006, cz), '#121314', 'metal');
    // the plate reads from the seat: TE ahead (top), 0, BE toward the driver, the slot between, WOAMA at the bottom
    faces.add(uvToRect(new THREE.PlaneGeometry(0.12, 0.28), atlas.add(112, 256, g => {
      g.fillStyle = '#121314'; g.fillRect(0, 0, 112, 256); g.fillStyle = '#000'; g.fillRect(70, 18, 10, 200);
      g.fillStyle = '#e6e6e6'; g.textAlign = 'center'; g.font = 'bold 20px Arial'; g.fillText('TE', 34, 34); g.fillText('0', 34, 118); g.fillText('BE', 34, 196);
      g.font = 'bold 12px Arial'; g.fillText('MAX', 34, 52); g.fillText('MAX', 34, 214); g.font = 'bold 15px Arial'; g.fillText('WOAMA', 56, 246);
    })), mat(cx, DESK_Y + 0.0135, cz, -Math.PI / 2, -Math.PI / 2), '#ffffff', 'faces');
    this.ctl = new THREE.Object3D();
    this.ctl.position.set(cx, DESK_Y + 0.012, cz + 0.023); // in the slot
    const ch = new GeoBatch();
    ch.cyl(0.008, 0.008, 0.17, 8, mat(0, 0.085, 0), '#bfc3c5', 'metal');
    ch.add(new THREE.SphereGeometry(0.03, 16, 12), mat(0, 0.18, 0), '#0e0e0e', 'metal');
    this.ctl.add(ch.build(M, false));
    this.group.add(this.ctl);
    // loco brake (SA9): a short joystick in a rubber boot on a wooden base, left of the paper
    shell.cyl(0.06, 0.07, 0.025, 20, mat(DESK_X0 + 0.2, DESK_Y + 0.012, -0.9), '#7a4a26');
    shell.cyl(0.03, 0.045, 0.05, 14, mat(DESK_X0 + 0.2, DESK_Y + 0.05, -0.9), '#141414');
    this.sa9 = new THREE.Object3D();
    this.sa9.position.set(DESK_X0 + 0.2, DESK_Y + 0.07, -0.9);
    const sb = new GeoBatch();
    sb.cyl(0.006, 0.006, 0.1, 8, mat(0, 0.05, 0), '#cfd3d5', 'metal');
    sb.add(new THREE.SphereGeometry(0.016, 12, 10), mat(0, 0.105, 0), '#111111', 'metal');
    this.sa9.add(sb.build(M, false));
    this.group.add(this.sa9);
    // automatic brake (A9): a quadrant plate on the desk's left end and its handle
    const ax = DESK_X0 + 0.16, az = -1.22;
    shell.box(0.24, 0.012, 0.16, mat(ax, DESK_Y + 0.006, az), '#141516', 'metal');
    faces.add(uvToRect(new THREE.PlaneGeometry(0.22, 0.14), atlas.add(220, 140, g => {
      g.fillStyle = '#141516'; g.fillRect(0, 0, 220, 140); g.fillStyle = '#d9d9d9'; g.font = 'bold 13px Arial';
      ['RELEASE', 'RUNNING', 'MIN', 'FULL SERVICE', 'EMERGENCY'].forEach((t, i) => g.fillText(t, 14, 26 + i * 25));
    })), mat(ax, DESK_Y + 0.0135, az, -Math.PI / 2, -Math.PI / 2), '#ffffff', 'faces');
    this.a9 = new THREE.Object3D();
    this.a9.position.set(ax + 0.08, DESK_Y + 0.03, az + 0.02);
    const ab = new GeoBatch();
    ab.cyl(0.03, 0.035, 0.03, 14, mat(0, 0, 0), '#1b1c1d', 'metal');
    ab.cyl(0.01, 0.01, 0.17, 8, mat(-0.085, 0.03, 0, 0, 0, Math.PI / 2), '#2a2b2c', 'metal');
    ab.add(new THREE.SphereGeometry(0.022, 12, 10), mat(-0.17, 0.03, 0), '#0e0e0e', 'metal');
    this.a9.add(ab.build(M, false));
    this.group.add(this.a9);
    // the working timetable, a pen
    faces.add(uvToRect(new THREE.PlaneGeometry(0.21, 0.28), atlas.add(256, 340, g => {
      g.fillStyle = '#f4f3ee'; g.fillRect(0, 0, 256, 340); g.fillStyle = '#555'; g.font = 'bold 13px Arial'; g.fillText('WORKING TIME TABLE', 50, 24);
      g.strokeStyle = '#a0a0a0';
      for (let y = 40; y < 320; y += 10) { g.beginPath(); g.moveTo(14, y); g.lineTo(242, y); g.stroke(); }
      for (const x of [56, 110, 168, 210]) { g.beginPath(); g.moveTo(x, 36); g.lineTo(x, 322); g.stroke(); }
    })), mat(DESK_X0 + 0.21, DESK_Y + 0.004, -0.36, -Math.PI / 2 + 0.1, -Math.PI / 2), '#ffffff', 'faces');
    shell.cyl(0.004, 0.004, 0.13, 6, mat(DESK_X0 + 0.24, DESK_Y + 0.008, -0.3, 0.6, 0, Math.PI / 2), '#1d3c8f');

    // ---- driver's windscreen: guard bars outside, a wiper ------------------------------------------
    const bars = new GeoBatch();
    for (const [wa, wb] of WINDOWS) {
      for (let z = wa + 0.05; z < wb - 0.03; z += 0.075) bars.box(0.01, WIN_Y1 - WIN_Y0 + 0.04, 0.01, mat(FRONT_X + 0.07, (WIN_Y0 + WIN_Y1) / 2, z), '#2a2d2f', 'metal');
      for (const y of [WIN_Y0 - 0.01, WIN_Y1 + 0.01]) bars.box(0.012, 0.02, wb - wa, mat(FRONT_X + 0.07, y, (wa + wb) / 2), '#2a2d2f', 'metal');
    }
    this.wiper = new THREE.Object3D();
    this.wiper.position.set(FRONT_X + 0.03, WIN_Y0 + 0.04, -1.08); // pivot at the window's bottom left, the arm resting along the bottom
    const wp = new GeoBatch();
    wp.box(0.012, 0.55, 0.012, mat(0, 0.275, 0), '#1a1a1a', 'metal');
    wp.box(0.008, 0.5, 0.02, mat(0.006, 0.3, 0.008), '#0b0b0b', 'metal');
    this.wiper.add(wp.build(M, false));
    this.wiper.rotation.x = 1.45;
    this.group.add(this.wiper);

    this.group.add(shell.build(M), faces.build(M, false), bars.build(M, false));
    // the room is lit by its windows and its lamp: no sun shadows inside (the shadow map is far too coarse for a desk)
    this.group.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = false; m.receiveShadow = false; } });
  }

  update(dt: number, r: CabReadings, night: number) {
    const s = this.sys, b = this.brakes;
    this.t += dt;
    this.faceMat.emissiveIntensity = 0.1 + night * 0.45;
    this.lampMat.color.setScalar(1);
    this.gauges.bpbc.set([r.bp, r.bc], dt);
    this.gauges.mr.set([r.mr], dt);
    this.gauges.er.set([r.er], dt);
    this.gauges.fp.set([Math.min(12, r.mr * 0.6)], dt); // feed pipe, from the main reservoir
    this.gauges.uba.set([r.kV], dt);
    const blink = Math.sin(this.t * 7) > 0;
    this.lamps.set(0, r.vcbOpen);
    this.lamps.set(1, r.pantoDown);
    this.lamps.set(2, r.slip);
    this.lamps.set(3, r.overspeed);
    this.lamps.set(4, r.vigilance !== 'ok' && blink);
    this.lamps.set(5, r.brakeApplied);
    // controller: forward (toward TE) for power, back (toward BE) for dynamic brake
    const power = s.notch / s.loco.notches, dyn = s.regen / s.loco.regen.notches;
    this.ctl.rotation.z = -0.5 * power + 0.5 * dyn;
    this.sa9.rotation.z = 0.35 * b.independent;
    this.a9.rotation.y = -0.2 + (b.handle / (BRAKE_POSITIONS.length - 1)) * 1.4;
    // wiper sweeps while on (slow / fast)
    if (s.wipers > 0) this.wipe += dt * (s.wipers > 1 ? 4.2 : 2.4);
    else this.wipe = Math.round(this.wipe / Math.PI) * Math.PI;
    this.wiper.rotation.x = 1.45 - (1 - Math.cos(this.wipe)) * 0.85; // up over the glass and back down
    // screens at 5 Hz
    this.acc += dt;
    if (this.acc < 0.2) return;
    this.acc = 0;
    this.drawBars(r);
    this.drawDdu(r);
    this.drawSpeedo(r);
  }

  /** U (line voltage) and the two bogies' traction current, as orange segment bars. */
  private drawBars(r: CabReadings) {
    const v = [r.kV / 30, Math.min(1, r.amps / 1400), Math.min(1, r.amps * 0.97 / 1400)];
    this.bars.draw(v.map(x => Math.round(x * 20)).join(), (g, w, h) => {
      g.fillStyle = '#060606'; g.fillRect(0, 0, w, h);
      v.forEach((x, i) => {
        const x0 = 14 + i * 82, segs = 20, lit = Math.round(x * segs);
        for (let k = 0; k < segs; k++) {
          g.fillStyle = k < lit ? (k > 16 ? '#ff6b1a' : '#ffa22a') : '#2a1a0a';
          g.fillRect(x0, h - 8 - (k + 1) * 4.8, 52, 3.6);
        }
      });
    });
  }

  /** The driver's display unit, laid out like the real one: header, bars, speed dial, values, soft keys. */
  private drawDdu(r: CabReadings) {
    const s = this.sys;
    const key = `${Math.round(r.displaySpeed)}|${r.limit}|${s.notch}|${s.regen}|${s.reverser}|${Math.round(r.teKN / 5)}|${Math.round(r.kV)}|${r.bp.toFixed(1)}|${r.bc.toFixed(1)}|${r.clock}|${r.aspect}|${Math.round(r.signalDist / 10)}|${r.vcbOpen}|${r.pantoDown}`;
    this.ddu.draw(key, (g, w, h) => {
      g.fillStyle = '#0b1a3a'; g.fillRect(0, 0, w, h);
      // header bar: green with the loco number, date / time
      g.fillStyle = '#5bd24a'; g.fillRect(0, 0, w, 34);
      g.fillStyle = '#0b2a0b'; g.font = 'bold 20px Arial'; g.textAlign = 'left'; g.fillText('WAG-9  31245', 10, 24);
      g.textAlign = 'right'; g.fillText(r.clock, w - 10, 24);
      g.fillStyle = '#e0ffe0'; g.fillRect(0, 34, w, 2);
      // left: vertical bar graphs (TE, BE, kV, BP, BC)
      const bars: [string, number, string][] = [
        ['TE', s.notch > 0 ? Math.min(1, r.teKN / 460) : 0, '#3ae07a'], ['BE', s.regen > 0 ? s.regen / s.loco.regen.notches : 0, '#f0c419'],
        ['kV', r.kV / 30, '#4aa8ff'], ['BP', r.bp / 6, '#ffffff'], ['BC', r.bc / 4, '#ff5a4a'],
      ];
      bars.forEach(([n, v, c], i) => {
        const x = 16 + i * 44, top = 56, bh = 250;
        g.fillStyle = '#1a2c55'; g.fillRect(x, top, 28, bh);
        g.fillStyle = c; g.fillRect(x, top + bh * (1 - Math.max(0, Math.min(1, v))), 28, bh * Math.max(0, Math.min(1, v)));
        g.strokeStyle = '#8fa4d0'; g.lineWidth = 1; g.strokeRect(x, top, 28, bh);
        g.fillStyle = '#d8e4ff'; g.font = 'bold 15px Arial'; g.textAlign = 'center'; g.fillText(n, x + 14, top + bh + 20);
      });
      // centre: speed dial with needle and digits
      const cx = 360, cy = 150, R = 92;
      g.strokeStyle = '#cfe0ff'; g.lineWidth = 4; g.beginPath(); g.arc(cx, cy, R, Math.PI * 0.75, Math.PI * 2.25); g.stroke();
      const vmax = 120;
      for (let k = 0; k <= 12; k++) {
        const a = Math.PI * 0.75 + (k / 12) * Math.PI * 1.5;
        g.beginPath(); g.moveTo(cx + Math.cos(a) * (R - 10), cy + Math.sin(a) * (R - 10)); g.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); g.stroke();
        if (k % 2 === 0) { g.fillStyle = '#cfe0ff'; g.font = '14px Arial'; g.textAlign = 'center'; g.fillText(String(k * 10), cx + Math.cos(a) * (R - 24), cy + Math.sin(a) * (R - 24) + 5); }
      }
      // the limit as a red mark on the dial
      const al = Math.PI * 0.75 + Math.min(1, r.limit / vmax) * Math.PI * 1.5;
      g.strokeStyle = '#ff3b30'; g.lineWidth = 6; g.beginPath(); g.arc(cx, cy, R + 6, al - 0.04, al + 0.04); g.stroke();
      const as = Math.PI * 0.75 + Math.min(1, r.displaySpeed / vmax) * Math.PI * 1.5;
      g.strokeStyle = '#ffffff'; g.lineWidth = 4; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(as) * (R - 16), cy + Math.sin(as) * (R - 16)); g.stroke();
      g.fillStyle = '#ffffff'; g.font = 'bold 40px Arial'; g.fillText(String(Math.round(r.displaySpeed)), cx, cy + 58);
      g.font = '14px Arial'; g.fillText(r.units, cx, cy + 78);
      // right: value boxes
      const vals: [string, string][] = [['NOTCH', s.notch > 0 ? `P${s.notch}` : s.regen > 0 ? `B${s.regen}` : '0'], ['DIR', s.reverser > 0 ? 'FWD' : s.reverser < 0 ? 'REV' : 'NEU'],
        ['TE kN', String(Math.round(r.teKN))], ['LIMIT', String(r.limit)], ['SIG', r.signalDist < 9999 ? `${r.aspect} ${Math.round(r.signalDist)}m` : '-']];
      vals.forEach(([n, v], i) => {
        const y = 52 + i * 52;
        g.fillStyle = '#16326e'; g.fillRect(482, y, 148, 44);
        g.fillStyle = '#9fb7e8'; g.font = '13px Arial'; g.textAlign = 'left'; g.fillText(n, 490, y + 16);
        g.fillStyle = n === 'LIMIT' && r.displaySpeed > r.limit + 2 ? '#ff5a4a' : '#ffffff'; g.font = 'bold 20px Arial'; g.fillText(v, 490, y + 38);
      });
      // bottom: soft keys (green ok, red fault)
      const keys: [string, boolean][] = [['VCB', !r.vcbOpen], ['PANTO', !r.pantoDown], ['COMP', true], ['BLOW', !r.vcbOpen], ['TRAC', s.notch > 0], ['BRK', r.bc < 0.3], ['VIG', true], ['DIAG', true]];
      keys.forEach(([n, ok], i) => {
        const x = 8 + i * 79, y = h - 46;
        g.fillStyle = ok ? '#1f8a3a' : '#b02020'; g.fillRect(x, y, 72, 38);
        g.fillStyle = '#ffffff'; g.font = 'bold 14px Arial'; g.textAlign = 'center'; g.fillText(n, x + 36, y + 24);
      });
    });
  }

  /** The speed recorder on the pillar: green dial, needle, a digital window below. */
  private drawSpeedo(r: CabReadings) {
    const v = Math.round(r.displaySpeed);
    this.speedo.draw(`${v}|${r.clock}`, (g, w) => {
      g.fillStyle = '#2b2e30'; g.fillRect(0, 0, w, 340);
      const cx = w / 2, cy = 140, R = 128;
      g.fillStyle = '#a8e07a'; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#1b2a12'; g.lineWidth = 3; g.fillStyle = '#1b2a12'; g.textAlign = 'center';
      for (let k = 0; k <= 14; k++) {
        const a = Math.PI * 0.8 + (k / 14) * Math.PI * 1.4;
        g.beginPath(); g.moveTo(cx + Math.cos(a) * (R - 16), cy + Math.sin(a) * (R - 16)); g.lineTo(cx + Math.cos(a) * (R - 4), cy + Math.sin(a) * (R - 4)); g.stroke();
        if (k % 2 === 0) { g.font = 'bold 17px Arial'; g.fillText(String(k * 10), cx + Math.cos(a) * (R - 34), cy + Math.sin(a) * (R - 34) + 6); }
      }
      const a = Math.PI * 0.8 + Math.min(1, r.displaySpeed / 140) * Math.PI * 1.4;
      g.lineWidth = 5; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * (R - 22), cy + Math.sin(a) * (R - 22)); g.stroke();
      g.beginPath(); g.arc(cx, cy, 9, 0, Math.PI * 2); g.fill();
      g.font = 'bold 15px Arial'; g.fillText('km/h', cx, cy + 46);
      // digital window
      g.fillStyle = '#7fc44a'; g.fillRect(cx - 62, cy + 62, 124, 34);
      g.fillStyle = '#10200a'; g.font = 'bold 24px monospace'; g.fillText(`${String(v).padStart(3, ' ')} ${r.clock.slice(0, 5)}`, cx, cy + 87);
    });
  }
}
