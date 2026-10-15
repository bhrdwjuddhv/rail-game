import * as THREE from 'three/webgpu';
import { GeoBatch, mat } from '../core/GeoBatch';
import { canvasTexture, labelTexture } from '../core/Textures';
import { materials } from '../core/Materials';
import { RAIL_TOP } from '@rail/shared/track/Chainage';
import { palm, type ClockSpot, type JunctionKit, type Place } from './JunctionArchitecture';

// painted plaster (warm, a little faded), granite, clay, timber
const OCHRE = '#d4a24c', TERRA = '#bf6a43', CREAM = '#eadcbc', BLUE = '#7fa7b5', GREEN = '#93ad84';
const GRANITE = '#ddd6cb', GRANITE_DK = '#bdb4a6', WOOD = '#6e4b33', MOSS = '#56653f', DARK = '#1f1a16';
/** pillar heights (template, to the top of the bracket) */
const RICH_H = 5.15, PLAIN_H = 4.32;
/** how far the platform canopies run each way from the centre (m) */
const HALF = 200;
/** gopuram: base (granite) and the painted tiers */
const G_LEN = 30, G_DEP = 16, G_BASE = 9.5, G_TIERS = 6, G_TIER_H = 3.6;
/** radius of the barrel-vaulted crown */
const CROWN_R = ((G_DEP - 1.6 - G_TIERS * 1.4) / 2) * 0.85;

/**
 * Sagarpur Central in a South Indian (Dravidian) temple-inspired style: a
 * railway station, with decorative motifs only (tiers, niches, bands, bracket
 * capitals, kalasam finials, lamps, kolam), no figures.
 *  - a gopuram-style entrance tower (granite base with a through passage, six
 *    painted tiers of niches and window shapes, a barrel-vaulted crown with a
 *    row of kalasams): full model near, plain stepped tiers further out, a
 *    painted impostor far away;
 *  - the booking hall as a mandapam: a grid of carved granite pillars under a
 *    flat stone roof with a painted lotus ceiling, ticket counters, waiting
 *    benches and live departure boards; prakaram colonnades along the road
 *    front and the main platform;
 *  - the station master's office with a small vimana tower holding the clock;
 *  - platforms under long pillared canopies with sloping clay-tile roofs, wide
 *    eaves and hanging brass lamps (granite pillars with bracket capitals,
 *    richer on the main platform);
 *  - a foot over bridge with stone parapets and small towers at the landings;
 *  - a forecourt with a stepped tank, stone lamp pillars (deepa stambha),
 *    coconut palms, banana plants and a kolam at the entrance.
 * Pillars and kalasams are instanced (one template each); the rest merges into
 * the station's batch.
 */
export function buildDravidian(k: JunctionKit): ClockSpot {
  const { s, b, st, side, H, M, bl, vault } = k;
  const Mt = materials() as unknown as Record<string, THREE.Material>;
  const rich: THREE.Matrix4[] = [], plain: THREE.Matrix4[] = [], kalasams: THREE.Matrix4[] = [];
  const kalasam = (dx: number, lat: number, up: number, sc: number) => kalasams.push(M(dx, lat, up, 0, 0, 0, sc, sc, sc));
  const lampAt = (dx: number, lat: number, up: number) => {
    const q = s.at(st.km + dx / 1000, lat);
    s.lamps?.push(new THREE.Vector3(q.x + s.ox, q.y + up, q.z + s.oz));
  };
  const onPlatform = (dx: number, lat: number) => { const q = s.at(st.km + dx / 1000, lat); return { x: q.x, y: q.y + H, z: q.z, ry: q.ry }; };
  /** a flat panel facing down (painted ceiling) */
  const ceiling = (dx: number, lat: number, up: number, len: number, wid: number) => {
    const t = ceilingTexture();
    const g = new THREE.PlaneGeometry(len, wid);
    const uv = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * len / 6, uv.getY(i) * wid / 6);
    const m = new THREE.Mesh(g, ceilingMaterial(t));
    const q = s.at(st.km + dx / 1000, lat);
    m.position.set(q.x, q.y + up, q.z);
    m.rotation.set(Math.PI / 2, q.ry, 0, 'YXZ');
    m.receiveShadow = true;
    s.group.add(m);
  };
  /** a sloping roof plane from (la, ya) to (lb, yb), seen from above (tiles) or below (timber) */
  const slope = (dx0: number, dx1: number, la: number, ya: number, lb: number, yb: number, color: string, key: string, below = false) => {
    const pts: [number, number][] = (la > lb) !== below ? [[la, ya], [lb, yb]] : [[lb, yb], [la, ya]];
    vault(dx0, dx1, pts, color, key, false, key === 'roof');
  };

  // ------------------------------------------------------------ platform canopies
  const main = st.platforms.reduce((m, p) => (side * (p.from + p.to) > side * (m.from + m.to) ? p : m));
  for (const p of st.platforms) {
    const lo = Math.min(p.from, p.to), hi = Math.max(p.from, p.to), w = hi - lo, mid = (lo + hi) / 2, isMain = p === main;
    const P = isMain ? RICH_H : PLAIN_H, rowL = [mid - 0.2 * w, mid + 0.2 * w];
    // gabled tile roof whose underside meets the beams on the pillar rows; eaves stay over the platform (OHE clear)
    const hw = 0.48 * w, rise = 0.32 * hw, y0 = H + P + 0.35 - (1 - 0.2 / 0.48) * rise;
    for (let dx = -HALF + 3; dx <= HALF - 3; dx += 6) for (const l of rowL) (isMain ? rich : plain).push(M(dx, l, H));
    for (const l of rowL) b.box(2 * HALF, 0.35, 0.5, M(0, l, H + P + 0.175), GRANITE_DK, 'stone');
    for (let dx = -HALF + 3; dx <= HALF - 3; dx += 6) b.box(0.4, 0.3, 0.4 * w + 0.5, M(dx, mid, H + P + 0.15), GRANITE_DK, 'stone');
    slope(-HALF, HALF, mid + hw, y0 + 0.14, mid, y0 + rise + 0.14, '#ffffff', 'roof');
    slope(-HALF, HALF, mid, y0 + rise + 0.14, mid - hw, y0 + 0.14, '#ffffff', 'roof');
    vault(-HALF, HALF, [[mid + 0.28, y0 + rise + 0.1], [mid, y0 + rise + 0.3], [mid - 0.28, y0 + rise + 0.1]], '#9a4a30', 'std'); // ridge tiles
    vault(-HALF, HALF, [[mid - hw, y0 + 0.14], [mid - hw, y0 - 0.02], [mid, y0 + rise - 0.02], [mid + hw, y0 - 0.02], [mid + hw, y0 + 0.14]], WOOD, 'std');
    for (const e of [mid - hw, mid + hw]) vault(-HALF, HALF, [[e - 0.03, y0 + 0.18], [e - 0.03, y0 - 0.32], [e + 0.03, y0 - 0.32], [e + 0.03, y0 + 0.18]], CREAM, 'std', true);
    k.cover(mid, hw, HALF, y0);
    // brass lamps hanging from the beams between the pillars
    for (let dx = -HALF + 6; dx <= HALF - 6; dx += 12) for (const l of rowL) {
      b.cyl(0.012, 0.012, 0.8, 4, M(dx, l, H + P - 0.4), '#3b3226', 'metal');
      b.cyl(0.2, 0.07, 0.22, 10, M(dx, l, H + P - 0.9), '#b8892e', 'metal');
      b.box(0.14, 0.14, 0.14, M(dx, l, H + P - 0.78), '#ffcf7a', 'lamp');
    }
    for (let dx = -HALF + 30; dx <= HALF - 30; dx += 48) lampAt(dx, mid, H + P - 1);
    // a digital clock near each end of the middle, speakers every 30 m under the cross beams
    s.fit?.clock(onPlatform(43, mid), P);
    s.fit?.clock(onPlatform(-59, mid), P);
    for (let dx = -HALF + 3; dx <= HALF - 3; dx += 30) if (dx !== 43 && dx !== -59) s.fit?.speaker(onPlatform(dx, mid + (dx % 60 ? 0.6 : -0.6)), P, dx % 60 ? 1 : -1);
    // the main platform: a painted ceiling over the hall section
    if (isMain) ceiling(0, mid, H + P + 0.36, 90, 0.4 * w - 0.5);
  }

  // ------------------------------------------------------------ mandapam (booking hall)
  const len = 170, dep = 36, hallH = 8;
  b.box(len, H + 2, dep, M(0, bl(dep / 2), (H - 2) / 2), GRANITE_DK, 'stone');
  b.box(len + 0.3, 0.3, dep + 0.3, M(0, bl(dep / 2), 0.15), MOSS, 'std');
  for (let dx = -81; dx <= 81; dx += 6) for (let d = 3; d < dep; d += 6) rich.push(M(dx, bl(d), H, 0, 0, 0, 1, hallH / RICH_H, 1));
  b.box(len + 2, 0.9, dep + 2, M(0, bl(dep / 2), H + hallH + 0.45), GRANITE, 'stone');
  b.box(len + 4, 0.45, dep + 4, M(0, bl(dep / 2), H + hallH + 1.12), OCHRE, 'std');
  // parapet of alternating painted blocks, kalasams along it
  const cols = [TERRA, CREAM, BLUE, CREAM];
  for (const d of [-1.6, dep + 1.6]) for (let dx = -len / 2 + 1.5, i = 0; dx <= len / 2 - 1.5; dx += 3, i++) b.box(2.7, 0.9, 0.5, M(dx, bl(d), H + hallH + 1.8), cols[i % 4], 'std');
  for (let dx = -81; dx <= 81; dx += 9) kalasam(dx, bl(-1.6), H + hallH + 2.25, 0.6);
  ceiling(0, bl(dep / 2), H + hallH - 0.01, len - 2, dep - 2);
  // walls: the road side (the gopuram's doorway in the middle) and the ends; the platform side is the open colonnade
  for (const e of [-1, 1]) {
    b.box(81, hallH, 0.6, M(e * 44.5, bl(dep - 0.3), H + hallH / 2), CREAM, 'std');
    b.box(81.1, 1.2, 0.66, M(e * 44.5, bl(dep - 0.3), H + 0.6), TERRA, 'std');
    b.box(0.6, hallH, dep, M(e * 85.3, bl(dep / 2), H + hallH / 2), CREAM, 'std');
    b.box(0.66, 1.2, dep + 0.1, M(e * 85.3, bl(dep / 2), H + 0.6), TERRA, 'std');
  }
  b.box(8, 2, 0.6, M(0, bl(dep - 0.3), H + 7), CREAM, 'std');
  // ticket counters along the back wall, west of the doorway
  for (let dx = -70; dx <= -26; dx += 4.4) {
    b.box(4, 3, 1.8, M(dx, bl(dep - 1.5), H + 1.5), WOOD, 'std');
    b.box(3.2, 1.2, 0.05, M(dx, bl(dep - 2.43), H + 1.8), '#22313a', 'std');
    b.box(3.6, 0.1, 0.4, M(dx, bl(dep - 2.6), H + 1.1), GRANITE_DK, 'stone');
  }
  const tk = labelTexture('tickets|sgpc', { bg: '#5b1f12', fg: '#f5d48a', w: 1024, h: 96, lines: ['टिकट   TICKETS   ટિકિટ'] });
  const tm = new THREE.Mesh(new THREE.PlaneGeometry(40, 1.4), new THREE.MeshStandardMaterial({ map: tk, roughness: 0.6, emissive: 0xffffff, emissiveMap: tk, emissiveIntensity: 0.2 }));
  { const q = s.at(st.km - 0.048, bl(dep - 2.43)); tm.position.set(q.x, q.y + H + 3.6, q.z); tm.rotation.y = q.ry + (side > 0 ? Math.PI : 0); s.group.add(tm); }
  // waiting area: granite benches between the pillars, east of the doorway
  for (let dx = 18; dx <= 72; dx += 6) for (const d of [12, 18, 24]) b.box(4, 0.45, 0.7, M(dx, bl(d), H + 0.225), GRANITE_DK, 'stone');
  // live departure boards hung from the ceiling: facing the platforms, and facing the entrance
  for (const [d, toRoad] of [[6, false], [dep - 7, true]] as const) {
    s.fit?.board(M(0, bl(d), H + 5.0, 0, 0, (side > 0) !== toRoad ? Math.PI : 0), 7, 2.8);
    for (const e of [-3, 3]) b.box(0.05, hallH - 6.4, 0.05, M(e, bl(d), H + 6.4 + (hallH - 6.4) / 2), '#3b3226', 'metal');
  }
  // lamps along the colonnade facing the platform
  for (let dx = -78; dx <= 78; dx += 6) {
    b.cyl(0.012, 0.012, 0.6, 4, M(dx, bl(3), H + hallH - 0.3), '#3b3226', 'metal');
    b.cyl(0.2, 0.07, 0.22, 10, M(dx, bl(3), H + hallH - 0.7), '#b8892e', 'metal');
    b.box(0.14, 0.14, 0.14, M(dx, bl(3), H + hallH - 0.58), '#ffcf7a', 'lamp');
  }
  k.cover(bl(dep / 2), dep / 2 + 1, 86, H + hallH);
  for (let dx = -72; dx <= 72; dx += 24) lampAt(dx, bl(1), H + hallH - 1);

  // ------------------------------------------------------------ prakaram colonnade along the road front
  const cd = dep, cw = 5.2;
  for (const e of [-1, 1]) {
    const c0 = e * (G_LEN / 2 + 1), c1 = e * 85.6, cm = (c0 + c1) / 2, cl = Math.abs(c1 - c0);
    b.box(cl, H + 2, cw, M(cm, bl(cd + cw / 2), (H - 2) / 2), GRANITE_DK, 'stone');
    b.box(cl + 0.2, 0.3, cw + 0.2, M(cm, bl(cd + cw / 2), 0.15), MOSS, 'std');
    for (let dx = Math.min(c0, c1) + 2; dx <= Math.max(c0, c1) - 1; dx += 4) {
      rich.push(M(dx, bl(cd + cw - 0.6), H, 0, 0, 0, 1, 4.4 / RICH_H, 1));
      b.box(0.16, 0.2, 0.16, M(dx + 2, bl(cd + cw - 0.6), H + 4.1), '#ffcf7a', 'lamp');
    }
    b.box(cl, 0.45, cw, M(cm, bl(cd + cw / 2), H + 4.62), GRANITE, 'stone');
    slope(Math.min(c0, c1), Math.max(c0, c1), bl(cd + 0.2), H + 5.9, bl(cd + cw + 1.0), H + 4.7, '#ffffff', 'roof');
    slope(Math.min(c0, c1), Math.max(c0, c1), bl(cd + cw), H + 4.86, bl(cd + cw + 1.0), H + 4.6, WOOD, 'std', true);
    k.cover(bl(cd + cw / 2), cw / 2 + 0.5, cl / 2, H + 4.4);
    for (let dx = cm - cl / 2 + 12; dx < cm + cl / 2; dx += 24) lampAt(dx, bl(cd + cw - 1), H + 3.8);
  }

  // ------------------------------------------------------------ gopuram (LOD: full, stepped tiers, impostor)
  const gl = bl(dep + G_DEP / 2), gq = s.at(st.km, gl);
  const lod = new THREE.LOD();
  lod.position.set(gq.x, gq.y, gq.z);
  const hiB = new GeoBatch(), loB = new GeoBatch();
  // the levels are built in the LOD's own frame (its origin at the tower's foot)
  const toLod = new THREE.Matrix4().makeTranslation(-gq.x, -gq.y, -gq.z);
  const GM: Place = (dx, lat, up, rx, rz, ry, sx, sy, sz) => M(dx, lat, up, rx, rz, ry, sx, sy, sz).premultiply(toLod);
  gopuram(hiB, GM, gl, H, true);
  gopuram(loB, GM, gl, H, false);
  const top = H + G_BASE + G_TIERS * G_TIER_H;
  for (let i = 0; i < 7; i++) kalasam(-5.4 + i * 1.8, gl, top + 0.5 + CROWN_R - 0.05, 1.1);
  lod.addLevel(hiB.build(Mt), 0);
  lod.addLevel(loB.build(Mt), 320);
  lod.addLevel(gopuramImpostor(gq.ry, top + 4.5), 900);
  s.group.add(lod);
  // lit softly from below at night
  for (const e of [-1, 1]) {
    b.box(0.6, 0.3, 0.6, M(e * 9, bl(dep + G_DEP + 1.2), 0.15), '#ffcf7a', 'lamp');
    lampAt(e * 9, bl(dep + G_DEP + 3), 1.2);
  }

  // ------------------------------------------------------------ station master's office and its vimana (clock)
  const vx = -112, vc = bl(8);
  b.box(24, H + 2, 14, M(vx, vc, (H - 2) / 2), GRANITE_DK, 'stone');
  b.box(22, 7, 12, M(vx, vc, H + 3.5), CREAM, 'std');
  b.box(22.1, 1.2, 12.1, M(vx, vc, H + 0.6), TERRA, 'std');
  b.box(23, 0.5, 13, M(vx, vc, H + 7.2), OCHRE, 'std');
  for (let dx = -8; dx <= 8; dx += 4) b.box(1.4, 2.0, 0.08, M(vx + dx, bl(1.97), H + 3.4), '#2b2622', 'std');
  let vy = H + 7.45;
  const tiers = [10, 8.1, 6.2, 4.3];
  tiers.forEach((sz, i) => {
    b.box(sz, 1.7, sz, M(vx, vc, vy + 0.85), i % 2 ? OCHRE : TERRA, 'std');
    b.box(sz + 0.5, 0.5, sz + 0.5, M(vx, vc, vy + 1.95), CREAM, 'std');
    if (i !== 1) for (const e of [-1, 1]) for (const f of [-1, 1]) {
      b.box(0.9, 1.1, 0.08, M(vx + e * sz * 0.25, vc + f * (sz / 2 + 0.04), vy + 0.85), DARK, 'std');
      b.box(0.08, 1.1, 0.9, M(vx + f * (sz / 2 + 0.04), vc + e * sz * 0.25, vy + 0.85), DARK, 'std');
    }
    vy += 2.2;
  });
  b.cyl(2.0, 2.3, 0.6, 8, M(vx, vc, vy + 0.3), CREAM, 'std');
  b.add(SHIKHARA_GEO, M(vx, vc, vy + 0.6, 0, 0, 0, 2.6, 2.4, 2.6), GREEN, 'std');
  kalasam(vx, vc, vy + 0.6 + 2.35, 1.0);

  // ------------------------------------------------------------ foot over bridge: stone parapets, small towers at the landings
  const fx = 90, deckY = RAIL_TOP + 8.4, lo = k.L0 + 1.6, hi = k.L1 - 1.6, fm = (lo + hi) / 2, fl = hi - lo + 4;
  b.box(3.6, 0.5, fl, M(fx, fm, deckY), GRANITE_DK, 'stone');
  for (const e of [-1, 1]) {
    b.box(0.35, 1.3, fl, M(fx + e * 1.75, fm, deckY + 0.9), GRANITE, 'stone');
    b.box(0.4, 0.25, fl, M(fx + e * 1.75, fm, deckY + 1.6), TERRA, 'std');
  }
  for (const p of st.platforms) {
    const mid = (p.from + p.to) / 2, th = deckY + 1.6 - H;
    b.box(4, th, 4, M(fx, mid, H + th / 2), GRANITE, 'stone');
    b.box(4.4, 0.4, 4.4, M(fx, mid, deckY + 1.8), OCHRE, 'std');
    b.box(3.2, 0.9, 3.2, M(fx, mid, deckY + 2.45), TERRA, 'std');
    b.box(3.5, 0.3, 3.5, M(fx, mid, deckY + 3.05), CREAM, 'std');
    kalasam(fx, mid, deckY + 3.2, 0.7);
  }

  // ------------------------------------------------------------ forecourt
  const front = dep + G_DEP;
  b.box(220, 0.3, 80, M(0, bl(front + 40), 0.05), GRANITE, 'stone');
  kolam(s, M, 0, bl(front + 7));
  // stepped tank: a raised granite basin, steps down inside to the water, lamps on the rim
  const tx = 62, tl = bl(front + 34), TS = 30;
  ring(b, M, tx, tl, TS, 1.2, 1.6, GRANITE_DK);
  for (let i = 0; i < 4; i++) ring(b, M, tx, tl, TS - 2.4 - i * 2.8, 1.4, 1.6 - (i + 1) * 0.32, GRANITE);
  const ws = TS - 2.4 - 4 * 2.8;
  b.box(ws + 1, 0.1, ws + 1, M(tx, tl, 0.32), '#2c3a3c', 'std');
  b.box(ws + 1, 0.06, ws + 1, M(tx, tl, 0.42), '#4f8fa8', 'glass');
  b.box(TS + 0.2, 0.3, TS + 0.2, M(tx, tl, 0.15), MOSS, 'std');
  for (let a = -TS / 2 + 2.5; a <= TS / 2 - 2.5; a += 5) for (const e of [-1, 1]) {
    b.box(0.22, 0.22, 0.22, M(tx + a, tl + e * (TS / 2 - 0.6), 1.72), '#ffcf7a', 'lamp');
    b.box(0.22, 0.22, 0.22, M(tx + e * (TS / 2 - 0.6), tl + a, 1.72), '#ffcf7a', 'lamp');
  }
  lampAt(tx, tl + side * (TS / 2), 2);
  lampAt(tx - TS / 2, tl, 2);
  // deepa stambhas along the path to the gopuram
  for (let d = front + 16; d <= front + 70; d += 18) for (const e of [-1, 1]) deepaStambha(b, M, e * 10, bl(d));
  lampAt(0, bl(front + 16), 6);
  lampAt(0, bl(front + 52), 6);
  // coconut palms round the tank and along the forecourt, banana plants by the hall's ends
  for (let a = -TS / 2; a <= TS / 2; a += 10) for (const e of [-1, 1]) palm(b, M, tx + a, tl + e * (TS / 2 + 3), 7 + ((a + e * 3) % 3 + 3) % 3);
  for (let dx = -100; dx <= 100; dx += 25) if (Math.abs(dx - tx) > 20) palm(b, M, dx, bl(front + 76), 8 + (Math.abs(dx) % 2));
  for (const e of [-1, 1]) for (let i = 0; i < 5; i++) banana(b, M, e * (89 + (i % 2) * 2), bl(6 + i * 6));
  // name boards: over the hall's platform front, and over the gopuram's doorway
  k.sign(0, bl(-1.9), H + hallH + 2.7, 40, 3.2, '#5b1f12', '#f5d48a');
  k.sign(0, bl(front + 0.12), H + 8.3, 20, 1.6, '#5b1f12', '#f5d48a', true);

  inst(s.group, richPillar(), Mt.stone, rich);
  inst(s.group, plainPillar(), Mt.stone, plain);
  inst(s.group, kalasamGeo(), Mt.metal, kalasams);
  // the clock in the vimana's first tier, facing the platforms
  return k.clockAt(vx, bl(8 - 5 - 0.06), H + 7.45 + 0.85, 1.0);
}

/** one InstancedMesh for every placement of a template */
function inst(group: THREE.Group, geo: THREE.BufferGeometry, material: THREE.Material, list: THREE.Matrix4[]) {
  if (!list.length) return;
  const im = new THREE.InstancedMesh(geo, material, list.length);
  list.forEach((m, i) => im.setMatrixAt(i, m));
  im.castShadow = true; im.receiveShadow = true;
  im.computeBoundingBox(); im.computeBoundingSphere();
  group.add(im);
}

/**
 * The gopuram, centred on (dx 0, lat gl): a granite base with a through passage
 * and moulded bands, six painted tiers stepping in, each with a row of niches
 * framed by pilasters and small arched hoods and a window shape in the middle
 * of each face, and a barrel-vaulted crown (the kalasams are instanced).
 * `full` false: the plain stepped tiers only (mid distance).
 */
function gopuram(b: GeoBatch, M: Place, gl: number, H: number, full: boolean) {
  b.box(G_LEN, H + G_BASE + 2, G_DEP, M(0, gl, (H + G_BASE - 2) / 2), GRANITE_DK, 'stone');
  if (full) {
    b.box(6.2, 7.5, G_DEP + 0.1, M(0, gl, H + 3.75), DARK, 'std');
    for (const y of [1.5, 5.2, G_BASE]) b.box(G_LEN + 0.4, 0.4, G_DEP + 0.4, M(0, gl, H + y), GRANITE, 'stone');
    b.box(G_LEN + 0.3, 0.35, G_DEP + 0.3, M(0, gl, 0.2), MOSS, 'std');
    for (let dx = -G_LEN / 2 + 1.5; dx <= G_LEN / 2 - 1.5; dx += 3) {
      if (Math.abs(dx) < 4.5) continue;
      for (const f of [-1, 1]) b.box(0.55, G_BASE - 1, 0.3, M(dx, gl + f * (G_DEP / 2 + 0.1), H + G_BASE / 2 + 0.3), GRANITE, 'stone');
    }
  }
  let y = H + G_BASE;
  for (let i = 0; i < G_TIERS; i++) {
    const a = G_LEN - 2 - i * 2.6, d = G_DEP - 1.6 - i * 1.4, body = G_TIER_H - 0.5;
    b.box(a, body, d, M(0, gl, y + body / 2), i % 2 ? TERRA : OCHRE, 'std');
    b.box(a + 0.6, 0.5, d + 0.6, M(0, gl, y + body + 0.25), CREAM, 'std');
    if (full) {
      const accent = i % 2 ? GREEN : BLUE;
      // long faces: niches every 2.4 m, the middle one a larger window shape
      const n = Math.floor(a / 2.4);
      for (let j = 0; j < n; j++) {
        const dx = -((n - 1) * 2.4) / 2 + j * 2.4, centre = Math.abs(dx) < 1.3;
        for (const f of [-1, 1]) {
          const lat = gl + f * (d / 2 + 0.04);
          b.box(centre ? 1.5 : 0.9, centre ? 2.3 : 1.6, 0.08, M(dx, lat, y + 1.35), DARK, 'std');
          for (const e of [-1, 1]) b.box(0.18, 2.3, 0.14, M(dx + e * (centre ? 0.95 : 0.65), lat, y + 1.4), accent, 'std');
          b.add(ARCH_GEO, M(dx, lat, y + (centre ? 2.5 : 2.15), 0, 0, 0, centre ? 0.8 : 0.5, centre ? 0.8 : 0.5, 1.4), CREAM, 'std');
        }
      }
      // short faces
      const m = Math.max(1, Math.floor(d / 2.4));
      for (let j = 0; j < m; j++) {
        const dl = -((m - 1) * 2.4) / 2 + j * 2.4;
        for (const f of [-1, 1]) b.box(0.08, 1.6, 0.9, M(f * (a / 2 + 0.04), gl + dl, y + 1.35), DARK, 'std');
      }
    }
    y += G_TIER_H;
  }
  // crown: a base course, a barrel vault along the tower's length with arched end gables
  const a = G_LEN - 2 - G_TIERS * 2.6, d = G_DEP - 1.6 - G_TIERS * 1.4, r = CROWN_R;
  b.box(a + 0.4, 0.5, d + 0.4, M(0, gl, y + 0.25), CREAM, 'std');
  b.add(VAULT_GEO, M(0, gl, y + 0.5, 0, Math.PI / 2, 0, r, a - 0.8, r), TERRA, 'std');
  if (full) for (const e of [-1, 1]) b.add(VAULT_GEO, M(e * (a / 2 - 0.25), gl, y + 0.5, 0, Math.PI / 2, 0, r + 0.35, 0.3, r + 0.35), CREAM, 'std');
}

/** the gopuram far away: two crossed painted quads */
function gopuramImpostor(ry: number, h: number) {
  const t = canvasTexture('gopuram-impostor', 256, 512, (g, w, hh) => {
    g.clearRect(0, 0, w, hh);
    const total = G_BASE + G_TIERS * G_TIER_H + 4.5, px = hh / total, cx = w / 2, sx = w / G_LEN;
    const rect = (wm: number, y0: number, y1: number, c: string) => { g.fillStyle = c; g.fillRect(cx - (wm * sx) / 2, hh - y1 * px, wm * sx, (y1 - y0) * px); };
    rect(G_LEN, 0, G_BASE, '#b9b2a6');
    g.fillStyle = '#2a221c'; g.fillRect(cx - 3.1 * sx, hh - 7.5 * px, 6.2 * sx, 7.5 * px);
    let y = G_BASE;
    for (let i = 0; i < G_TIERS; i++) {
      const a = G_LEN - 2 - i * 2.6;
      rect(a, y, y + G_TIER_H - 0.5, i % 2 ? '#bf6a43' : '#d4a24c');
      rect(a + 0.6, y + G_TIER_H - 0.5, y + G_TIER_H, '#eadcbc');
      g.fillStyle = '#3a2a20';
      for (let x = -a / 2 + 1.2; x < a / 2 - 0.8; x += 2.4) g.fillRect(cx + x * sx - 2, hh - (y + 2.2) * px, 4, 1.6 * px);
      y += G_TIER_H;
    }
    const a = G_LEN - 2 - G_TIERS * 2.6;
    g.fillStyle = '#bf6a43';
    g.beginPath(); g.ellipse(cx, hh - (y + 0.5) * px, (a * sx) / 2, 2.6 * px, 0, Math.PI, 0); g.fill();
    g.fillStyle = '#d6a93a';
    for (let i = 0; i < 7; i++) g.fillRect(cx + (-5.4 + i * 1.8) * sx - 3, hh - (y + 4.3) * px, 6, 1.6 * px);
  }, { repeat: false });
  const m = new THREE.MeshStandardMaterial({ map: t, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.9 });
  const grp = new THREE.Group();
  for (const [w, r] of [[G_LEN, 0], [G_DEP, Math.PI / 2]] as const) {
    const g = new THREE.PlaneGeometry(w, h);
    g.translate(0, h / 2, 0);
    const q = new THREE.Mesh(g, m);
    q.rotation.y = ry + r;
    grp.add(q);
  }
  return grp;
}

/** a square ring of granite (a step course of the tank): outer size, height, top at `top` */
function ring(b: GeoBatch, M: Place, dx: number, lat: number, size: number, wdt: number, top: number, color: string) {
  const h = Math.max(0.2, top + 0.5), y = top - h / 2;
  for (const e of [-1, 1]) {
    b.box(size, h, wdt, M(dx, lat + e * (size / 2 - wdt / 2), y), color, 'stone');
    b.box(wdt, h, size - 2 * wdt, M(dx + e * (size / 2 - wdt / 2), lat, y), color, 'stone');
  }
}

/** a stone lamp pillar: base, shaft ringed with lamp tiers, a lamp bowl on top */
function deepaStambha(b: GeoBatch, M: Place, dx: number, lat: number) {
  b.box(1.3, 0.6, 1.3, M(dx, lat, 0.3), GRANITE_DK, 'stone');
  b.cyl(0.24, 0.3, 5.2, 8, M(dx, lat, 3.2), GRANITE, 'stone');
  for (let i = 0; i < 5; i++) {
    const y = 1.6 + i * 0.9, r = 0.62 - i * 0.07;
    b.cyl(r, r, 0.08, 10, M(dx, lat, y), GRANITE_DK, 'stone');
    b.box(0.1, 0.1, 0.1, M(dx + r - 0.08, lat, y + 0.09), '#ffcf7a', 'lamp');
    b.box(0.1, 0.1, 0.1, M(dx - r + 0.08, lat, y + 0.09), '#ffcf7a', 'lamp');
  }
  b.cyl(0.42, 0.2, 0.3, 10, M(dx, lat, 5.95), '#b8892e', 'metal');
  b.box(0.28, 0.25, 0.28, M(dx, lat, 6.2), '#ffcf7a', 'lamp');
}

/** a banana plant: a short pseudo-stem and broad drooping leaves */
function banana(b: GeoBatch, M: Place, dx: number, lat: number) {
  b.cyl(0.13, 0.18, 1.9, 6, M(dx, lat, 0.95), '#7d8a4a', 'std');
  const top = M(dx, lat, 1.85);
  for (let i = 0; i < 6; i++) b.box(2.1, 0.03, 0.6, top.clone().multiply(mat(0, 0, 0, (i / 6) * Math.PI * 2 + dx, 0, -0.45)).multiply(mat(1.0, 0, 0)), i % 2 ? '#5f9a35' : '#6fae3e');
}

/** the kolam at the entrance: white rice-flour dots and loops on the paving */
function kolam(s: JunctionKit['s'], M: Place, dx: number, lat: number) {
  const t = canvasTexture('kolam', 512, 512, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.strokeStyle = '#f7f3ea'; g.fillStyle = '#f7f3ea'; g.lineWidth = 7; g.lineCap = 'round';
    const n = 7, step = w / (n + 1);
    for (let i = 1; i <= n; i++) for (let j = 1; j <= n; j++) { g.beginPath(); g.arc(i * step, j * step, 6, 0, Math.PI * 2); g.fill(); }
    for (let i = 1; i < n; i++) for (let j = 1; j < n; j++) {
      if ((i + j) % 2) continue;
      g.beginPath(); g.arc((i + 0.5) * step, (j + 0.5) * step, step * 0.62, 0, Math.PI * 2); g.stroke();
    }
    g.lineWidth = 9;
    g.beginPath(); g.arc(w / 2, h / 2, w * 0.46, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = '#d9483b'; g.lineWidth = 6;
    g.beginPath(); g.arc(w / 2, h / 2, w * 0.43, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = '#e8b92f';
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      g.beginPath(); g.ellipse(w / 2 + Math.cos(a) * w * 0.16, h / 2 + Math.sin(a) * h * 0.16, w * 0.1, w * 0.04, a, 0, Math.PI * 2); g.stroke();
    }
  }, { repeat: false });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(11, 11), new THREE.MeshStandardMaterial({ map: t, transparent: true, depthWrite: false, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
  m.applyMatrix4(M(dx, lat, 0.21, -Math.PI / 2));
  s.group.add(m);
}

/** the painted ceiling: lotus medallions in a geometric grid (repeats every 6 m) */
function ceilingTexture() {
  return canvasTexture('dravidian-ceiling', 256, 256, (g, w, h) => {
    g.fillStyle = '#8e3b23'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#eadcbc'; g.lineWidth = 10; g.strokeRect(5, 5, w - 10, h - 10);
    g.strokeStyle = '#2a7f7a'; g.lineWidth = 4; g.strokeRect(18, 18, w - 36, h - 36);
    const cx = w / 2, cy = h / 2;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      g.fillStyle = i % 2 ? '#f4e3c1' : '#e9c46a';
      g.beginPath(); g.ellipse(cx + Math.cos(a) * 48, cy + Math.sin(a) * 48, 40, 15, a, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = '#2a7f7a'; g.beginPath(); g.arc(cx, cy, 30, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#e9c46a'; g.beginPath(); g.arc(cx, cy, 14, 0, Math.PI * 2); g.fill();
    for (const [x, y] of [[30, 30], [w - 30, 30], [30, h - 30], [w - 30, h - 30]]) {
      g.fillStyle = '#e9c46a'; g.beginPath(); g.arc(x, y, 10, 0, Math.PI * 2); g.fill();
    }
  });
}
let ceilingMat: THREE.MeshStandardMaterial | null = null;
const ceilingMaterial = (t: THREE.Texture) => (ceilingMat ??= new THREE.MeshStandardMaterial({ map: t, roughness: 0.9 }));

/** a carved granite pillar: base, alternating square and octagonal sections with bands, lotus capital, bracket with drooping ends */
function richPillar() {
  const b = new GeoBatch(), G = '#e2dcd2', D = '#bdb4a6';
  b.box(0.95, 0.8, 0.95, mat(0, 0.4, 0), D, 'stone');
  b.box(0.82, 0.16, 0.82, mat(0, 0.88, 0), G, 'stone');
  b.box(0.62, 1.1, 0.62, mat(0, 1.51, 0), G, 'stone');
  b.box(0.68, 0.14, 0.68, mat(0, 2.1, 0), D, 'stone');
  b.cyl(0.33, 0.33, 0.7, 8, mat(0, 2.52, 0), G, 'stone');
  b.box(0.66, 0.9, 0.66, mat(0, 3.32, 0), G, 'stone');
  for (const y of [2.93, 3.71]) b.box(0.7, 0.12, 0.7, mat(0, y, 0), D, 'stone');
  b.cyl(0.31, 0.31, 0.6, 8, mat(0, 4.07, 0), G, 'stone');
  b.box(0.6, 0.3, 0.6, mat(0, 4.52, 0), G, 'stone');
  b.cyl(0.46, 0.3, 0.26, 8, mat(0, 4.8, 0), D, 'stone');
  for (const r of [0, Math.PI / 2]) {
    b.box(1.7, 0.26, 0.42, mat(0, 5.02, 0, r), G, 'stone');
    for (const e of [-1, 1]) b.box(0.32, 0.34, 0.44, mat(0, 0, 0, r).multiply(mat(e * 0.75, 4.86, 0)), D, 'stone');
  }
  return b.geometry('stone')!;
}

/** the outer platforms' pillar: plain shaft with two bands, bracket capital */
function plainPillar() {
  const b = new GeoBatch(), G = '#e2dcd2', D = '#bdb4a6';
  b.box(0.7, 0.5, 0.7, mat(0, 0.25, 0), D, 'stone');
  b.box(0.45, 3.4, 0.45, mat(0, 2.2, 0), G, 'stone');
  for (const y of [1.4, 3.0]) b.box(0.5, 0.12, 0.5, mat(0, y, 0), D, 'stone');
  b.cyl(0.34, 0.24, 0.2, 8, mat(0, 4.0, 0), D, 'stone');
  for (const r of [0, Math.PI / 2]) b.box(1.2, 0.22, 0.34, mat(0, 4.21, 0, r), G, 'stone');
  return b.geometry('stone')!;
}

/** a kalasam (pot finial), 1.5 m tall at scale 1 */
function kalasamGeo() {
  const pts = [[0, 0], [0.32, 0.04], [0.48, 0.28], [0.44, 0.52], [0.2, 0.68], [0.27, 0.78], [0.12, 0.92], [0.15, 1.08], [0.05, 1.38], [0, 1.5]].map(([x, y]) => new THREE.Vector2(x, y));
  return new GeoBatch().add(new THREE.LatheGeometry(pts, 10), null, '#d6a93a', 'metal').geometry('metal')!;
}

const ARCH_GEO = new THREE.TorusGeometry(1, 0.1, 5, 12, Math.PI);
/** half cylinder (radius 1, length 1 along y) with its round side up once turned on its side */
const VAULT_GEO = new THREE.CylinderGeometry(1, 1, 1, 14, 1, false, 0, Math.PI);
const SHIKHARA_GEO = new THREE.SphereGeometry(1, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2);
