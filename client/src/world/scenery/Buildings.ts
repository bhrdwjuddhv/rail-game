import TEXTURES from '../../../../data/textures.json';
import * as THREE from 'three/webgpu';
import { rng } from '@rail/shared/util';
import { GeoBatch, mat } from '../../core/GeoBatch';
import { canvasTexture, uvToRect } from '../../core/Textures';
import { BuildingLayout, BuildingStyle, buildingFootprint, buildingLayout, BUILDINGS_DATA, cellInfo } from './buildingKit';
import { PLINTH_DEPTH } from './Placement';
import { lifeCells, pickCell, STENCIL_SKIP } from './lifeKit';

/**
 * Town building geometry (layouts: buildingKit). Parts by material, so every building of a style shares
 * its draws: the card (facade-<style>: the atlas cell, cut out), the block, parapets and roof clutter
 * (std), a clay-tile hipped roof (roof), a tin or slate gable roof (metal).
 */
/** the trim sheet is in (processed or its source present): parapets get its strips */
const TRIM_ON = (TEXTURES.textures as unknown as Record<string, { processed?: unknown; source?: boolean }>)['buildings/trim']?.processed !== undefined;
const hex = (c: number[], k = 1) => `#${c.map(v => Math.round(Math.min(1, Math.max(0, v * k)) * 255).toString(16).padStart(2, '0')).join('')}`;

export function buildingTemplate(type: string) {
  const [, style, cell, variant] = type.split('-');
  const L = buildingLayout(style as BuildingStyle, +cell, +variant);
  const b = new GeoBatch(), r = rng(Math.floor(L.seed * 2 ** 31));
  // foundation from 15 cm above the base down to PLINTH_DEPTH below it (as every building: Props)
  const [fx, fz] = buildingFootprint(L.style, L.cell, L.variant);
  if (L.kind !== 'wall') b.box(fx * 2 + 0.3, PLINTH_DEPTH + 0.15, fz * 2 + 0.3, mat(0, (0.15 - PLINTH_DEPTH) / 2, 0), '#9c968c');
  card(b, L, 1);
  if (L.kind === 'wall') card(b, L, -1);
  const bw = L.bx1 - L.bx0, cx = (L.bx0 + L.bx1) / 2, wall = hex(L.colour);
  // the block behind the card (its front hidden by the card); a compound wall is the card's thickness only
  b.box(bw, L.top, L.d, mat(cx, L.top / 2, 0), wall);
  if (L.kind !== 'wall') {
    if (L.roof === 'flat') flatRoof(b, L, r, bw, cx, wall);
    else if (L.roof === 'hipped') {
      const hip = new THREE.CylinderGeometry(0, 1, 1, 4, 1);
      hip.rotateY(Math.PI / 4);
      const rh = Math.max(1.4, L.h - L.top);
      b.add(hip, mat(cx, L.top + rh / 2, -0.25, 0, 0, 0, (bw + 1.2) / Math.SQRT2, rh, (L.d + 1.2) / Math.SQRT2), '#ffffff', 'roof');
    } else gableRoof(b, L, bw, cx, wall);
    // marigold garlands over a shop front (every day) and many a house front (festival mode only), a toran over a
    // door, a rangoli (a kolam in the south) at the entrance, a stencil or two on a side wall
    const g = r(), tr = r(), rg = r(), st = r(), pick = r();
    if (L.kind === 'shop' || (L.kind === 'house' && g < 0.45)) garland(b, L, pick, L.kind === 'shop' ? 'life-cutout' : 'festive-decal');
    else if (L.kind === 'house' && tr < 0.5) toran(b, L, pick);
    if (L.kind !== 'construction' && rg < 0.55) rangoli(b, L, r);
    if (st < 0.35) stencil(b, L, r);
    // an AC unit and a meter box on a side wall (most town houses have one)
    if (r() < 0.6) { const s = r() < 0.5 ? -1 : 1; b.box(0.3, 0.6, 0.9, mat(s * (bw / 2 + 0.15) + cx, Math.min(L.top - 1, 2.6 + r() * 3), (r() - 0.5) * L.d * 0.6), '#d9dbd6'); }
    if (r() < 0.4) b.box(0.12, 0.5, 0.35, mat(cx + bw / 2 + 0.06, 1.8, L.d / 2 - 0.6), '#5d6266');
  }
  if (L.kind !== 'wall' && L.kind !== 'construction') festive(b, L, r);
  const parts = [{ geometry: b.geometry(`facade-${style}`)!, material: `facade-${style}`, shadow: true }];
  for (const key of ['std', 'roof', 'metal', 'slate', 'trim']) { const g = b.geometry(key); if (g) parts.push({ geometry: g, material: key, shadow: true }); }
  // decals (the life cut-out pack: garlands, torans, rangoli, stencils): no shadows of their own
  for (const key of ['life-cutout', 'festive-decal']) { const dg = b.geometry(key); if (dg) parts.push({ geometry: dg, material: key, shadow: false }); }
  // (festival mode: its material is shown only then, by night)
  for (const key of ['festive', 'festive-sprite']) { const fg = b.geometry(key); if (fg) parts.push({ geometry: fg, material: key, shadow: false }); }
  return parts;
}

/** The atlas cell as a card on the front (face +1) or the back (-1, the same picture: a compound wall's other side). */
function card(b: GeoBatch, L: BuildingLayout, face: 1 | -1) {
  const [u0, v0, u1, v1] = L.uv;
  const g = uvToRect(new THREE.PlaneGeometry(L.w, L.h), { u0, v0, u1, v1 });
  g.translate(0, L.h / 2, 0);
  b.add(g, mat(0, 0, face * (L.d / 2 + 0.04), face > 0 ? 0 : Math.PI), '#ffffff', `facade-${L.style}`);
}

/**
 * Flat roof: a slab, a parapet round the sides and back (the front's is in the drawing), and what Indian roofs
 * carry: black water tanks, a stair room, solar panels, a dish aerial, a washing line; rods left for the next
 * floor on a building going up; machine rooms on city blocks.
 */
function flatRoof(b: GeoBatch, L: BuildingLayout, r: () => number, bw: number, cx: number, wall: string) {
  const y = L.top, d = L.d, back = -d / 2;
  b.box(bw + 0.1, 0.15, d + 0.1, mat(cx, y, 0), '#a49d93');
  for (const s of [-1, 1]) b.box(0.15, 0.9, d, mat(cx + s * (bw / 2 - 0.07), y + 0.45, 0), wall);
  b.box(bw, 0.9, 0.15, mat(cx, y + 0.45, back + 0.07), wall);
  // the parapets' outer faces in the trim sheet's balustrade strip (row 4 of 8), a cornice (row 1) below them
  if (TRIM_ON) {
    const strip = (len: number, row: number, h: number, yy: number, m: THREE.Matrix4) => {
      const g = new THREE.PlaneGeometry(len, h), uv = g.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * len, 1 - (row + 1 - uv.getY(i) * 0.9 - 0.05) / 8);
      b.add(g, m.multiply(mat(0, yy, 0)), wall, 'trim');
    };
    for (const s of [-1, 1]) { strip(d, 3, 0.9, y + 0.45, mat(cx + s * (bw / 2 + 0.01), 0, 0, s * Math.PI / 2)); strip(d, 0, 0.45, y - 0.25, mat(cx + s * (bw / 2 + 0.02), 0, 0, s * Math.PI / 2)); }
    strip(bw, 3, 0.9, y + 0.45, mat(cx, 0, back - 0.01, Math.PI)); strip(bw, 0, 0.45, y - 0.25, mat(cx, 0, back - 0.02, Math.PI));
  }
  const spot = (fx: number, fz: number) => [cx + fx * (bw / 2 - 1.4), back + 1.2 + fz * (d - 2.6)] as const;
  if (L.kind === 'construction') {
    for (let i = 0; i < 8; i++) { const [x, z] = spot(i % 2 ? 1 : -1, (i >> 1) / 3); b.box(0.04, 1.3, 0.04, mat(x + (r() - 0.5) * 0.3, y + 0.65, z), '#4a4038'); }
    return;
  }
  if (L.kind === 'tower') {
    const [x, z] = spot(r() * 2 - 1, 0.2);
    b.box(4, 3, 4, mat(x, y + 1.5, z), wall);
    for (let i = 0; i < 2 + Math.floor(r() * 3); i++) { const [tx, tz] = spot(r() * 2 - 1, 0.6 + r() * 0.4); b.cyl(0.7, 0.7, 1.3, 10, mat(tx, y + 0.8, tz), '#1d1f22'); }
    return;
  }
  if (r() < 0.75) {
    // black plastic tanks on a little stand (sometimes a white one)
    const [x, z] = spot(r() * 2 - 1, r() * 0.4);
    b.box(1.6, 0.5, 1.6, mat(x, y + 0.25, z), '#8c867c');
    b.cyl(0.6, 0.62, 1.2, 10, mat(x, y + 1.1, z), r() < 0.8 ? '#1b1c1e' : '#e8e6e0');
  }
  if (r() < 0.4 && L.h > 6) {
    const [x, z] = spot(r() < 0.5 ? -1 : 1, 0);
    b.box(2.6, 2.4, 2.8, mat(x, y + 1.2, z), wall);
    b.box(2.9, 0.12, 3.1, mat(x, y + 2.45, z), '#a49d93');
    b.box(0.9, 1.9, 0.06, mat(x, y + 0.95, z + 1.43), '#5a3a22');
  }
  if (r() < 0.3) {
    const [x, z] = spot(r() * 2 - 1, 0.5 + r() * 0.5);
    b.box(1.7, 0.06, 1.0, mat(x, y + 0.75, z, 0, 0.45), '#1e2c4a');
    b.box(0.06, 0.6, 0.06, mat(x, y + 0.3, z - 0.3), '#777');
  }
  if (r() < 0.35) {
    const [x, z] = spot(r() * 2 - 1, r());
    b.box(0.05, 1.2, 0.05, mat(x, y + 0.6, z), '#555');
    b.cyl(0.38, 0.38, 0.06, 10, mat(x, y + 1.25, z, 0, 0.9), '#d8d8d8');
  }
  if (r() < 0.35) {
    // a washing line between two posts, clothes on it
    const [x, z] = spot(0, 0.3 + r() * 0.5), len = Math.min(4, bw - 2);
    for (const s of [-1, 1]) b.box(0.05, 1.7, 0.05, mat(x + s * len / 2, y + 0.85, z), '#555');
    b.box(len, 0.02, 0.02, mat(x, y + 1.65, z), '#333');
    const cloth = ['#c0392b', '#2980b9', '#f1c40f', '#ecf0f1', '#8e44ad', '#27ae60', '#e67e22'], clothes = lifeCells('life/cutout-pack', 'clothes');
    for (let i = 0; i < 4; i++) {
      const cx2 = x - len / 2 + 0.5 + i * (len - 1) / 3, pickC = r(), w = 0.5 + r() * 0.3, h = 0.6 + r() * 0.4;
      // (the clothesline atlas's clothes, cut out, hanging from the line; else squares of colour)
      if (clothes.length) { const c = clothes[Math.floor(pickC * clothes.length)]; decal(b, c.uv, 0.75 * c.aspect, 0.75, mat(cx2, y + 1.27, z)); }
      else b.box(w, h, 0.02, mat(cx2, y + 1.3, z), cloth[Math.floor(pickC * cloth.length)]);
    }
  }
}

/** A marigold string across the front above the ground floor's openings: the pack's garland strip, else flowers (boxes). */
function garland(b: GeoBatch, L: BuildingLayout, pick: number, key: string) {
  const strip = pickCell('life/cutout-pack', 'garland', pick);
  if (strip) {
    const span = Math.min(L.w * 0.85, (L.bx1 - L.bx0) * 0.95), h = Math.max(0.28, span / strip.aspect);
    decal(b, strip.uv, span, h, mat((L.bx0 + L.bx1) / 2, Math.min(3.1, L.top - 0.3) - h / 2, L.d / 2 + 0.1), key);
    return;
  }
  if (key !== 'life-cutout') return;
  const span = Math.min(L.w * 0.8, (L.bx1 - L.bx0) * 0.9), y = Math.min(3.1, L.top - 0.3), z = L.d / 2 + 0.12, n = 9, x0 = (L.bx0 + L.bx1) / 2 - span / 2;
  for (let i = 0; i < n; i++) { const u = i / (n - 1); b.box(0.16, 0.16, 0.16, mat(x0 + u * span, y - 2.2 * u * (1 - u), z), i % 2 ? '#f39c12' : '#f7c600'); }
  for (const x of [x0, x0 + span]) b.box(0.13, 0.6, 0.13, mat(x, y - 0.35, z), '#e67e22');
}

/** A toran (door hanging) over the door, from the pack. */
function toran(b: GeoBatch, L: BuildingLayout, pick: number) {
  const t = pickCell('life/cutout-pack', 'toran', pick);
  if (!t) return;
  const w = Math.min(2.2, (L.bx1 - L.bx0) * 0.5), h = w / t.aspect;
  decal(b, t.uv, w, h, mat((L.bx0 + L.bx1) / 2, 2.35 - h / 2, L.d / 2 + 0.11));
}

/** A stencil or a poster scrap on a side wall (an arrow, a handprint, a meter box... never the flag). */
function stencil(b: GeoBatch, L: BuildingLayout, r: () => number) {
  const s = pickCell('life/cutout-pack', 'stencils', r(), STENCIL_SKIP);
  if (!s || L.kind === 'wall') return;
  const side = r() < 0.5 ? -1 : 1, h = 0.7 + r() * 0.6, w = h * s.aspect;
  decal(b, s.uv, w, h, mat(side > 0 ? L.bx1 + 0.02 : L.bx0 - 0.02, 1.2 + r() * Math.max(0.2, L.top - 3), (r() - 0.5) * (L.d - w - 0.4), side * Math.PI / 2));
}

/** A decal quad from the life cut-out pack (facing +z before m), polygon offset in its material. */
function decal(b: GeoBatch, uv: number[], w: number, h: number, m: THREE.Matrix4, key = 'life-cutout') {
  b.add(uvToRect(new THREE.PlaneGeometry(w, h), { u0: uv[0], v0: uv[1], u1: uv[2], v1: uv[3] }), m, '#ffffff', key);
}

/** A rangoli at the entrance (a kolam in the south): from the pack, flat on the ground; else rings of powder (discs). */
function rangoli(b: GeoBatch, L: BuildingLayout, r: () => number) {
  const x = (L.bx0 + L.bx1) / 2 + (r() - 0.5) * 2, z = L.d / 2 + 1.1;
  const art = pickCell('life/cutout-pack', L.style === 'ghats' ? 'kolam' : 'rangoli', r());
  if (art) { const s = 1.3 + r() * 0.5; decal(b, art.uv, s, s / art.aspect, mat(x, 0.03, z, r() * 6.28, -Math.PI / 2)); return; }
  const cols = [['#f4f4f0', '#e84393', '#f7c600'], ['#f4f4f0', '#0984e3', '#e17055'], ['#f4f4f0', '#00b894', '#fd79a8']][Math.floor(r() * 3)];
  cols.forEach((c, i) => b.cyl(0.8 - i * 0.24, 0.8 - i * 0.24, 0.012, 12, mat(x, 0.02 + i * 0.006, z), c));
}

/** Festival lights: strings of coloured bulbs down from the roof's front edge, a row of diyas on the doorstep. */
function festive(b: GeoBatch, L: BuildingLayout, r: () => number) {
  const cols = ['#ffd27a', '#ff6b6b', '#7bed9f', '#70a1ff', '#ff9ff3'], z = L.d / 2 + 0.08, top = L.top + (L.roof === 'flat' ? 0.85 : 0);
  const strands = Math.max(3, Math.round((L.bx1 - L.bx0) / 1.6));
  for (let i = 0; i < strands; i++) {
    const x = L.bx0 + 0.3 + (i * (L.bx1 - L.bx0 - 0.6)) / (strands - 1), len = Math.min(top - 0.5, 3 + r() * 3);
    for (let k = 0; k < len / 0.45; k++) b.box(0.07, 0.07, 0.07, mat(x, top - k * 0.45, z), cols[(i + k) % cols.length], 'festive');
  }
  const diya = pickCell('life/festival-pack', 'diyas', r()), lantern = pickCell('life/festival-pack', 'lanterns', r());
  // diyas along the doorstep, a paper lantern hung at the door (sprites from the festival pack; else little lamps)
  for (let k = 0; k < 5; k++) {
    const x = (L.bx0 + L.bx1) / 2 - 1 + k * 0.5;
    if (diya) b.add(uvToRect(new THREE.PlaneGeometry(0.28, 0.28 / diya.aspect), { u0: diya.uv[0], v0: diya.uv[1], u1: diya.uv[2], v1: diya.uv[3] }), mat(x, 0.1, L.d / 2 + 0.45), '#ffffff', 'festive-sprite');
    else b.box(0.09, 0.07, 0.09, mat(x, 0.05, L.d / 2 + 0.45), '#ffb347', 'festive');
  }
  if (lantern) b.add(uvToRect(new THREE.PlaneGeometry(0.55 * lantern.aspect, 0.55), { u0: lantern.uv[0], v0: lantern.uv[1], u1: lantern.uv[2], v1: lantern.uv[3] }), mat((L.bx0 + L.bx1) / 2 + 1.2, 2.5, L.d / 2 + 0.35), '#ffffff', 'festive-sprite');
}

/** Gable roof (tin or slate, the colour drawn above the walls): ridge along the front, triangles at the ends. */
function gableRoof(b: GeoBatch, L: BuildingLayout, bw: number, cx: number, wall: string) {
  const rh = Math.max(1.5, Math.min(3.5, L.h - L.top)), run = L.d / 2 + 0.6, len = Math.hypot(run, rh), a = Math.atan2(rh, run);
  // (a grey roof drawn: slate - its texture, tinted; a coloured one: painted tin)
  const [cr, cg, cb] = L.cap, grey = Math.max(cr, cg, cb) - Math.min(cr, cg, cb) < 0.08;
  // (each slope falls from the ridge to its eave: tilted about x so its outer edge is the low one)
  for (const s of [-1, 1]) b.box(bw + 1, 0.1, len, mat(cx, L.top + rh / 2, s * run / 2, 0, s * a), grey ? hex(L.cap, 1.6) : hex(L.cap), grey ? 'slate' : 'metal');
  const tri = new THREE.Shape([new THREE.Vector2(-L.d / 2, 0), new THREE.Vector2(L.d / 2, 0), new THREE.Vector2(0, rh)]);
  for (const s of [-1, 1]) {
    const g = new THREE.ShapeGeometry(tri);
    g.rotateY(s > 0 ? Math.PI / 2 : -Math.PI / 2);
    b.add(g, mat(cx + s * bw / 2, L.top, 0), wall);
  }
}

/**
 * The stand-in atlas when a style's image is missing (or not processed): sixteen plain fronts, one per cell,
 * where buildingKit's cellInfo expects them, in the style's colours, with a window per bay and floor.
 */
export function standInAtlas(style: BuildingStyle) {
  return canvasTexture(`facadeAtlas-${style}`, 512, 512, (g, W, H) => {
    g.clearRect(0, 0, W, H);
    for (let cell = 0; cell < 16; cell++) {
      const ci = cellInfo(style, cell), [u0, v0, u1, v1] = ci.rect, t = BUILDINGS_DATA.styles[style].tiles[cell];
      const x0 = u0 * W, x1 = u1 * W, y0 = (1 - v1) * H, y1 = (1 - v0) * H, bodyTop = (1 - ci.body[3]) * H;
      g.fillStyle = hex(ci.cap ?? ci.colour); g.fillRect(x0, y0, x1 - x0, bodyTop - y0);
      g.fillStyle = hex(ci.colour); g.fillRect(x0, bodyTop, x1 - x0, y1 - bodyTop);
      const floors = Math.max(1, Math.round(t.h / 3.3)), fh = (y1 - bodyTop) / floors, bays = Math.max(2, Math.round((x1 - x0) / fh));
      for (let f = 0; f < floors; f++) for (let k = 0; k < bays; k++) {
        const wx = x0 + (k + 0.3) * (x1 - x0) / bays, wy = y1 - (f + 1) * fh + fh * 0.25, door = f === 0 && k === bays >> 1;
        g.fillStyle = door ? '#5a3a22' : '#2b3138';
        g.fillRect(wx, door ? y1 - fh * 0.75 : wy, (x1 - x0) / bays * 0.4, door ? fh * 0.75 : fh * 0.4);
      }
    }
  }, { repeat: false });
}

