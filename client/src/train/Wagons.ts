import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rng } from '@rail/shared/util';
import type { CoachData } from '@rail/shared/train/Consist';
import { GeoBatch, mat } from '../core/GeoBatch';
import { canvasTexture } from '../core/Textures';

/**
 * Freight wagon models (instanced per type by TrainView): body geometry with
 * its own textured material, and an underframe in the shared metal
 * material. Original designs and fictional markings throughout.
 *
 *   boxcar     covered wagon: ribbed steel box, sliding doors both sides,
 *              weathered red-brown with dirt streaks and stencilled numbers,
 *              hand brake wheel at one end, CBC couplers
 *   container  low well/flat frame carrying containers: double stack
 *              (40 ft + 40 ft high-cube, or 2 x 20 ft + 40 ft), single 40 ft, or empty.
 *              Container colours vary per wagon (instance tint); the three
 *              fictional shipping lines are drawn on the sides
 *   brakevan   guard's van with end verandahs; its tail lamp is TrainView's
 */

export interface WagonTemplate { body: THREE.BufferGeometry; under: THREE.BufferGeometry; mat: THREE.MeshStandardMaterial }

const SHIPPING = [
  { name: 'OCEANIC STAR', sub: 'LOGISTICS', mark: 'star' },
  { name: 'KAVERI LINES', sub: 'CONTAINER SERVICES', mark: 'wave' },
  { name: 'SEABRIDGE', sub: 'FREIGHT', mark: 'ring' },
];

/** Map a box's faces to texture regions: sides (+-z) to [u0,u1] x [v0,v1], everything else to `other`. */
function boxUV(g: THREE.BufferGeometry, side: [number, number, number, number], end: [number, number, number, number], other: [number, number]) {
  const uv = g.getAttribute('uv') as THREE.BufferAttribute, n = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const nz = n.getZ(i), nx = n.getX(i);
    const u = uv.getX(i), v = uv.getY(i);
    if (Math.abs(nz) > 0.5) uv.setXY(i, side[0] + (nz > 0 ? u : 1 - u) * (side[1] - side[0]), side[2] + v * (side[3] - side[2]));
    else if (Math.abs(nx) > 0.5) uv.setXY(i, end[0] + u * (end[1] - end[0]), end[2] + v * (end[3] - end[2]));
    else uv.setXY(i, other[0], other[1]);
  }
  return g;
}

/** Corrugated steel: vertical ribs as light/dark stripes. */
function ribs(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, base: string, pitch: number) {
  g.fillStyle = base; g.fillRect(x, y, w, h);
  for (let px = x; px < x + w; px += pitch) {
    g.fillStyle = 'rgba(255,255,255,0.10)'; g.fillRect(px, y, pitch * 0.35, h);
    g.fillStyle = 'rgba(0,0,0,0.16)'; g.fillRect(px + pitch * 0.55, y, pitch * 0.2, h);
  }
}

/** Rust and dirt: streaks running down from the roof, grime along the bottom. */
function weather(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, seed: number, amount: number) {
  const r = rng(seed);
  for (let i = 0; i < 70 * amount; i++) {
    const sx = x + r() * w, len = h * (0.15 + r() * 0.7);
    g.fillStyle = `rgba(${60 + r() * 50},${40 + r() * 25},${25 + r() * 15},${0.08 + r() * 0.16})`;
    g.fillRect(sx, y, 1 + r() * 4, len);
  }
  const grd = g.createLinearGradient(0, y + h * 0.7, 0, y + h);
  grd.addColorStop(0, 'rgba(50,38,28,0)'); grd.addColorStop(1, `rgba(50,38,28,${0.45 * amount})`);
  g.fillStyle = grd; g.fillRect(x, y + h * 0.7, w, h * 0.3);
}

function boxcarTexture(c: CoachData) {
  return canvasTexture(`wagon-${c.id}`, 1024, 512, (g) => {
    // side panel (top half), end panel (bottom left), roof colour (bottom right)
    const W = 1024, H = 256;
    ribs(g, 0, 0, W, H, c.livery.body, 28);
    for (const dx of [W / 2 - 150, W / 2]) {              // sliding door pair in the middle
      g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(dx, 18, 150, H - 26);
      g.strokeStyle = 'rgba(20,10,5,0.6)'; g.lineWidth = 4; g.strokeRect(dx + 2, 18, 146, H - 28);
      g.fillStyle = 'rgba(0,0,0,0.35)'; for (const y of [60, 130, 200]) g.fillRect(dx + 8, y, 134, 6);
    }
    g.fillStyle = '#2b1d14'; g.fillRect(W / 2 - 160, 6, 320, 10);  // door track
    weather(g, 0, 0, W, H, 7, 1);
    // stencilled markings (fictional fleet numbers)
    g.fillStyle = '#efe8dc'; g.font = 'bold 26px Arial'; g.textAlign = 'left';
    g.fillText('BRN', 40, 60); g.fillText('BCNX  40 27 118 6', 40, 92);
    g.font = '18px Arial';
    g.fillText('TARE 27.0 T   CC 58.0 T', 40, 122); g.fillText('LOAD 85.0 T   RETURN TO RAMPUR', 40, 146);
    g.textAlign = 'right'; g.fillText('POH 08/26   ROH 02/27', W - 40, 70);
    g.fillStyle = '#d8c21e'; g.fillRect(W - 140, 200, 90, 18);
    // end panel
    ribs(g, 0, 256, 300, 256, c.livery.body, 30);
    weather(g, 0, 256, 300, 256, 9, 0.8);
    g.fillStyle = c.livery.roof; g.fillRect(320, 256, 704, 256);
  }, { repeat: false });
}

function containerTexture(c: CoachData, line: number) {
  const ship = SHIPPING[line % SHIPPING.length];
  return canvasTexture(`wagon-${c.id}-${line}`, 1024, 512, (g) => {
    // light base: the instance tint gives the colour; row 1: 40 ft side, row 2: 20 ft side + door end + roof
    const side = (x: number, y: number, w: number, h: number, big: boolean) => {
      ribs(g, x, y, w, h, '#f4f4f4', big ? 16 : 18);
      g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 6; g.strokeRect(x + 3, y + 3, w - 6, h - 6);
      weather(g, x, y, w, h, 13 + line, 0.5);
      g.fillStyle = 'rgba(255,255,255,0.92)'; g.textAlign = 'center';
      g.font = `bold ${big ? 58 : 40}px Arial`; g.fillText(ship.name, x + w / 2, y + h * 0.48);
      g.font = `bold ${big ? 26 : 18}px Arial`; g.fillText(ship.sub, x + w / 2, y + h * 0.66);
      // the line's own mark
      const mx = x + (big ? 90 : 60), my = y + h * 0.44, r = big ? 30 : 20;
      g.strokeStyle = 'rgba(255,255,255,0.92)'; g.lineWidth = big ? 7 : 5; g.beginPath();
      if (ship.mark === 'ring') g.arc(mx, my, r, 0, Math.PI * 2);
      else if (ship.mark === 'wave') { g.moveTo(mx - r, my); g.quadraticCurveTo(mx - r / 2, my - r, mx, my); g.quadraticCurveTo(mx + r / 2, my + r, mx + r, my); }
      else for (let k = 0; k < 5; k++) { const a = -Math.PI / 2 + k * 4 * Math.PI / 5; (k ? g.lineTo : g.moveTo).call(g, mx + Math.cos(a) * r, my + Math.sin(a) * r); }
      g.stroke();
      g.font = '16px monospace'; g.textAlign = 'left'; g.fillStyle = 'rgba(255,255,255,0.85)';
      g.fillText(`${ship.name.slice(0, 3)}U ${String(400000 + line * 13751).slice(0, 6)} ${line + 2}`, x + w - (big ? 280 : 200), y + 30);
    };
    side(0, 0, 1024, 256, true);
    side(0, 256, 600, 256, false);
    // door end: two leaves with locking bars
    g.fillStyle = '#ececec'; g.fillRect(610, 256, 250, 256);
    g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(733, 256, 4, 256);
    for (const x of [650, 700, 770, 820]) { g.fillStyle = '#5a5f63'; g.fillRect(x, 262, 7, 244); g.fillRect(x - 6, 380, 19, 10); }
    weather(g, 610, 256, 250, 256, 21 + line, 0.5);
    g.fillStyle = '#d6d6d6'; g.fillRect(870, 256, 154, 256);   // roof
  }, { repeat: false });
}

function brakevanTexture(c: CoachData) {
  return canvasTexture(`wagon-${c.id}`, 1024, 512, (g) => {
    ribs(g, 0, 0, 1024, 256, c.livery.body, 34);
    g.fillStyle = c.livery.band; g.fillRect(0, 150, 1024, 14);
    for (const x of [300, 640]) { g.fillStyle = '#1b2228'; g.fillRect(x, 50, 90, 70); g.strokeStyle = '#d8d0bd'; g.lineWidth = 4; g.strokeRect(x, 50, 90, 70); }
    g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(470, 30, 90, 210);
    weather(g, 0, 0, 1024, 256, 31, 0.9);
    g.fillStyle = '#efe8dc'; g.font = 'bold 26px Arial'; g.textAlign = 'center'; g.fillText('BRN   BVZI   21 57 004', 512, 220);
    ribs(g, 0, 256, 300, 256, c.livery.body, 30);
    g.fillStyle = c.livery.roof; g.fillRect(320, 256, 704, 256);
  }, { repeat: false });
}

const SIDE40: [number, number, number, number] = [0, 1, 0.5, 1];
const SIDE20: [number, number, number, number] = [0, 600 / 1024, 0, 0.5];
const ENDC: [number, number, number, number] = [610 / 1024, 860 / 1024, 0, 0.5];
const ROOFC: [number, number] = [0.92, 0.25];

/** Underframe, bogie-side frames, couplers and buffers' shared parts. */
function underframe(b: GeoBatch, L: number, frameY: number, w: number) {
  b.box(L - 0.6, 0.32, w, mat(0, frameY, 0), '#24272a', 'metal');
  for (const e of [-1, 1]) {
    b.box(0.5, 0.22, 0.3, mat(e * (L / 2 + 0.1), 0.95, 0), '#2a2a2a', 'metal');   // CBC coupler
    b.box(0.22, 0.45, w - 0.2, mat(e * (L / 2 - 0.15), frameY - 0.05, 0), '#2c2f32', 'metal'); // headstock
  }
}

export function wagonTemplate(c: CoachData): WagonTemplate {
  const L = c.lengthM - 0.5;
  const b = new GeoBatch();
  const parts: THREE.BufferGeometry[] = [];
  let map: THREE.Texture;
  if (c.kind === 'container') {
    const line = c.id.length + c.id.charCodeAt(c.id.length - 1);
    map = containerTexture(c, line);
    // low frame: a well between the bogies so a double stack clears the wires
    const FRAME = 1.05, well = 0.55;
    underframe(b, L, FRAME, 2.6);
    b.box(L - 6.4, 0.28, 2.7, mat(0, well + 0.1, 0), '#262a2d', 'metal'); // well floor
    for (const z of [-1.3, 1.3]) b.box(L - 6.0, 0.55, 0.12, mat(0, well + 0.38, z), '#2b2f33', 'metal'); // well side sills
    for (const e of [-1, 1]) b.box(2.8, 0.25, 2.7, mat(e * (L / 2 - 1.7), FRAME + 0.1, 0), '#262a2d', 'metal'); // ends over the bogies
    const box40 = (y: number, h: number) => parts.push(boxUV(new THREE.BoxGeometry(12.19, h, 2.44), SIDE40, ENDC, ROOFC).translate(0, y + h / 2, 0));
    const box20 = (x: number, y: number) => parts.push(boxUV(new THREE.BoxGeometry(6.06, 2.59, 2.44), SIDE20, ENDC, ROOFC).translate(x, y + 2.59 / 2, 0));
    const floor = well + 0.25;
    if (c.containers === 'double') { box40(floor, 2.59); box40(floor + 2.6, 2.9); }
    else if (c.containers === 'double-20') { box20(-3.07, floor); box20(3.07, floor); box40(floor + 2.6, 2.9); }
    else if (c.containers === 'single') box40(floor, 2.9);
    // corner castings / twist locks at the container corners
    if (c.containers && c.containers !== 'empty') for (const x of [-6.0, 6.0]) for (const z of [-1.17, 1.17]) b.box(0.18, 0.16, 0.16, mat(x, floor + 0.08, z), '#3b3f42', 'metal');
  } else if (c.kind === 'brakevan') {
    map = brakevanTexture(c);
    underframe(b, L, 1.1, 2.7);
    const bodyL = L - 3.2;
    parts.push(boxUV(new THREE.BoxGeometry(bodyL, 2.5, 2.9), [0, 1, 0.5, 1], [0, 300 / 1024, 0, 0.5], [0.6, 0.25]).translate(0, 1.27 + 1.25, 0));
    parts.push(boxUV(new THREE.BoxGeometry(L - 0.2, 0.12, 3.1), [0, 1, 0.5, 1], [0, 300 / 1024, 0, 0.5], [0.6, 0.25]).translate(0, 3.85, 0)); // roof overhang
    for (const e of [-1, 1]) {
      b.box(1.5, 0.08, 2.8, mat(e * (L / 2 - 0.85), 1.32, 0), '#3a3530', 'metal');                          // verandah floor
      for (const z of [-1.35, 1.35]) b.cyl(0.025, 0.025, 1.1, 6, mat(e * (L / 2 - 0.2), 1.9, z), '#d9d4c8', 'metal'); // handrail posts
      b.box(0.04, 0.04, 2.7, mat(e * (L / 2 - 0.2), 2.4, 0), '#d9d4c8', 'metal');
      b.box(1.5, 0.04, 0.04, mat(e * (L / 2 - 0.85), 2.4, 1.35), '#d9d4c8', 'metal');
      b.box(1.5, 0.04, 0.04, mat(e * (L / 2 - 0.85), 2.4, -1.35), '#d9d4c8', 'metal');
      for (const z of [-1.0, 1.0]) b.box(0.3, 0.28, 0.25, mat(e * (L / 2 - 0.2), 0.5, z), '#2a2a2a', 'metal');   // steps
    }
    b.cyl(0.1, 0.12, 0.5, 8, mat(0, 4.1, 0.9), '#2c2c2c', 'metal');   // stove pipe
  } else {
    // boxcar
    map = boxcarTexture(c);
    underframe(b, L, 1.08, 2.8);
    const H = 2.95, base = 1.22;
    parts.push(boxUV(new THREE.BoxGeometry(L - 0.4, H, 3.05), [0, 1, 0.5, 1], [0, 300 / 1024, 0, 0.5], [0.6, 0.25]).translate(0, base + H / 2, 0));
    const roof = new THREE.CylinderGeometry(3.6, 3.6, L - 0.4, 24, 1, false, -0.43, 0.86).rotateZ(Math.PI / 2).rotateX(Math.PI / 2).translate(0, base + H - 3.6 + 0.28, 0);
    const ru = roof.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < ru.count; i++) ru.setXY(i, 0.6, 0.25);
    parts.push(roof);
    // hand brake wheel at the B end, door rollers, ladder rungs
    b.add(new THREE.TorusGeometry(0.22, 0.025, 6, 20).rotateY(Math.PI / 2), mat(-(L / 2) + 0.12, 2.0, 0.9), '#1d1d1d', 'metal');
    b.cyl(0.02, 0.02, 0.9, 6, mat(-(L / 2) + 0.12, 1.55, 0.9), '#1d1d1d', 'metal');
    for (let k = 0; k < 6; k++) b.box(0.04, 0.03, 0.42, mat(L / 2 - 0.15, 1.45 + k * 0.38, -1.2), '#222', 'metal');
    for (const z of [-1.55, 1.55]) b.box(4.2, 0.08, 0.06, mat(0, base + H - 0.1, z), '#2b1d14', 'metal');
  }
  const body = mergeParts(parts);
  const material = new THREE.MeshStandardMaterial({ map, roughness: 0.78, metalness: 0.12 });
  return { body, under: b.geometry('metal')!, mat: material };
}

function mergeParts(parts: THREE.BufferGeometry[]) {
  if (!parts.length) {
    // an empty container wagon still needs a body mesh: a tiny hidden quad under the frame
    return new THREE.PlaneGeometry(0.01, 0.01).rotateX(-Math.PI / 2).translate(0, 0.3, 0);
  }
  const out = mergeGeometries(parts, false)!;
  out.computeBoundingSphere();
  return out;
}

/** A loose 40 ft container (yards, ships) in shipping line `line`'s markings; instance colour = its paint. */
export function looseContainer(line: number) {
  const map = containerTexture({ id: 'yard' } as CoachData, line);
  return {
    geo: boxUV(new THREE.BoxGeometry(12.19, 2.59, 2.44), SIDE40, ENDC, ROOFC),
    mat: new THREE.MeshStandardMaterial({ map, roughness: 0.78, metalness: 0.12 }),
  };
}

/** Deterministic tint for vehicle `i` of a train (containers' colours, weathering). */
export function wagonTint(c: CoachData, i: number) {
  if (!c.tints?.length) return null;
  const h = Math.abs(Math.sin(i * 12.9898 + c.id.length * 78.233) * 43758.5453) % 1;
  return c.tints[Math.floor(h * c.tints.length)];
}
