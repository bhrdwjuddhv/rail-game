import * as THREE from 'three/webgpu';
import { FastBatch, mat } from '../../core/GeoBatch';
import { canvasTexture, uvToRect } from '../../core/Textures';
import { lampPool } from '../scenery/Props';
import { boardKey, routeSigns, stoneKey } from './RoadSigns';
import { materials } from '../../core/Materials';
import { isTouch } from '../../input/Device';
import { hash2, rng } from '@rail/shared/util';
import { newFrame } from '@rail/shared/track/Chainage';
import type { Route } from '@rail/shared/track/Route';
import type { GroundSample, TerrainField } from '../TerrainField';
import { flareAt, formationHalf, type ParallelRoad, parallelRoads, pavedHalf, roadTop, ROUNDABOUT, SECTION, TOLL, TOLL_W } from './Highways';

/**
 * The roads alongside the line drawn as real roads (see Highways for where they run): built per km and streamed
 * like the line's other structures, three draws a km - the surface (one atlas: its markings painted in), the
 * fixtures (median, kerbs, oleanders, shoulders, embankment, bridges, painted signs on the road) and the road
 * studs (unlit: they show in the dark); a toll plaza's lights add one.
 *
 * The atlas holds, side by side across u, a highway carriageway in asphalt and in concrete (inner shoulder, two
 * lanes, outer shoulder: the yellow line by the median, the dashed lane line, the edge line), a state highway
 * (edge lines, a dashed centre line), a town street (worn, no lines) and a toll plaza's apron (plain concrete);
 * along v it repeats every PERIOD m.
 */
const PERIOD = 18;
/** u ranges of the atlas strips */
const STRIP = { nh: [0.004, 0.276], nhc: [0.29, 0.562], sh: [0.576, 0.79], street: [0.804, 0.9], apron: [0.914, 0.996] } as const;
/** widths (m) the strips cover: a carriageway (inner shoulder + lanes + outer shoulder), a 2-lane road */
const NH_W = SECTION.nh.inner + SECTION.nh.lanes * SECTION.nh.lane + SECTION.nh.shoulder;

function roadAtlas() {
  const t = canvasTexture('road-atlas', 2048, 1024, (g, W, H) => {
    const r = rng(9157);
    const ppmV = H / PERIOD;
    const strip = (k: keyof typeof STRIP, widthM: number, concrete: boolean, draw: (x: (m: number) => number, w: (m: number) => number) => void) => {
      const x0 = STRIP[k][0] * W, x1 = STRIP[k][1] * W, ppm = (x1 - x0) / widthM;
      g.save();
      g.beginPath(); g.rect(x0 - 8, 0, x1 - x0 + 16, H); g.clip();
      // the surface: asphalt aggregate (grey specks), or concrete slabs
      g.fillStyle = concrete ? '#a8a49c' : k === 'street' ? '#56585a' : '#45474a';
      g.fillRect(x0 - 8, 0, x1 - x0 + 16, H);
      for (let i = 0; i < (x1 - x0) * H / 9; i++) {
        const v = r();
        g.fillStyle = concrete ? (v < 0.5 ? 'rgba(80,78,72,0.25)' : 'rgba(225,222,214,0.25)') : v < 0.45 ? 'rgba(25,26,28,0.45)' : v < 0.9 ? 'rgba(110,112,114,0.4)' : 'rgba(150,140,125,0.5)';
        g.fillRect(x0 - 8 + r() * (x1 - x0 + 16), r() * H, 1 + r() * 2, 1 + r() * 2);
      }
      draw(m => x0 + m * ppm, m => m * ppm);
      g.restore();
    };
    const band = (x: number, w: number, a: number) => { for (let k = 0; k < 4; k++) { g.fillStyle = `rgba(0,0,0,${a / 4})`; g.fillRect(x - w / 2 - k * w * 0.12, 0, w + k * w * 0.24, H); } };
    /** paint: solid or dashed (dash, gap in m), worn a little (lighter dashes, flecks of road showing) */
    const paint = (x: number, w: number, col: string, dash?: [number, number]) => {
      const step = dash ? (dash[0] + dash[1]) * ppmV : H;
      for (let y = 0; y < H; y += step) {
        g.globalAlpha = 0.72 + r() * 0.23;
        g.fillStyle = col;
        g.fillRect(x - w / 2, y, w, dash ? dash[0] * ppmV : H);
      }
      g.globalAlpha = 1;
      for (let i = 0; i < H * w / 30; i++) { g.fillStyle = 'rgba(60,62,64,0.55)'; g.fillRect(x - w / 2 + r() * w, r() * H, 1 + r() * 2, 1 + r() * 2); }
    };
    const cracks = (x: (m: number) => number, a: number, b: number, n: number) => {
      g.strokeStyle = 'rgba(18,18,18,0.55)'; g.lineWidth = 1.2;
      for (let i = 0; i < n; i++) {
        let px = x(a + r() * (b - a)), py = r() * H;
        g.beginPath(); g.moveTo(px, py);
        for (let k = 0; k < 6; k++) { px += (r() - 0.5) * 18; py += 6 + r() * 16; g.lineTo(px, py); }
        g.stroke();
      }
    };
    const patch = (x: (m: number) => number, w: (m: number) => number, a: number, b: number) => {
      const y = r() * H * 0.8, h = (1.5 + r() * 3) * ppmV, px = x(a + r() * (b - a - 1.5));
      const pw = w(1 + r());
      g.fillStyle = 'rgba(28,29,31,0.28)'; g.fillRect(px, y, pw, h);
      g.strokeStyle = 'rgba(15,15,15,0.45)'; g.lineWidth = 1.5; g.strokeRect(px, y, pw, h);
    };
    // a highway carriageway (m from its inner edge: inner shoulder, fast lane, slow lane, outer shoulder)
    const S = SECTION.nh, laneA = S.inner, laneB = S.inner + S.lane, laneC = S.inner + 2 * S.lane;
    for (const concrete of [false, true]) strip(concrete ? 'nhc' : 'nh', NH_W, concrete, (x, w) => {
      // the shoulder: lighter, dusty
      g.fillStyle = concrete ? 'rgba(200,190,170,0.18)' : 'rgba(150,135,110,0.16)'; g.fillRect(x(laneC), 0, w(S.shoulder + 0.2), H);
      // tyre tracks down each lane
      for (const lc of [laneA + S.lane / 2, laneB + S.lane / 2]) for (const s of [-0.9, 0.9]) band(x(lc + s), w(0.55), concrete ? 0.14 : 0.2);
      if (concrete) {
        // slab joints: across every 4.5 m, along the lane lines
        g.fillStyle = 'rgba(40,40,38,0.55)';
        for (let y = 0; y < H; y += 4.5 * ppmV) g.fillRect(x(0), y, w(NH_W), 2);
        for (const m of [laneB, laneC]) g.fillRect(x(m) - 1, 0, 2, H);
        // oil drips down the middle of the lanes
        for (let i = 0; i < 40; i++) { g.fillStyle = 'rgba(30,28,25,0.18)'; const lc = r() < 0.5 ? laneA + S.lane / 2 : laneB + S.lane / 2; g.beginPath(); g.ellipse(x(lc + (r() - 0.5) * 0.4), r() * H, 3 + r() * 6, 5 + r() * 12, 0, 0, 7); g.fill(); }
      } else {
        // a tar seam along the lane line, repair patches, cracks
        g.fillStyle = 'rgba(15,15,16,0.5)'; g.fillRect(x(laneB) - 3, 0, 2, H);
        for (let i = 0; i < 3; i++) patch(x, w, laneA, laneC);
        cracks(x, laneA, laneC + 1, 7);
      }
      paint(x(0.42), w(0.15), '#e3b51e');                          // the yellow line by the median
      paint(x(laneB), w(0.15), '#ecebe5', [3, 6]);                  // lane line, 3 m dashes
      paint(x(laneC + 0.1), w(0.2), '#ecebe5');                     // edge line
    });
    // a state highway: two lanes, edge lines, a dashed centre line
    strip('sh', 7, false, (x, w) => {
      for (const lc of [1.75, 5.25]) for (const s of [-0.85, 0.85]) band(x(lc + s), w(0.5), 0.22);
      for (let i = 0; i < 4; i++) patch(x, w, 0.3, 6.7);
      cracks(x, 0.2, 6.8, 9);
      paint(x(0.22), w(0.15), '#ecebe5');
      paint(x(6.78), w(0.15), '#ecebe5');
      paint(x(3.5), w(0.12), '#ecebe5', [3, 6]);
      // dusty, broken edges
      g.fillStyle = 'rgba(140,120,95,0.25)'; g.fillRect(x(0), 0, w(0.25), H); g.fillRect(x(6.75), 0, w(0.25), H);
    });
    // a toll plaza's apron: concrete slabs, no lines
    strip('apron', 4, true, (x, w) => {
      g.fillStyle = 'rgba(40,40,38,0.5)';
      for (let y = 0; y < H; y += 4.5 * ppmV) g.fillRect(x(0), y, w(4), 2);
      g.fillRect(x(2) - 1, 0, 2, H);
    });
    // a town street: worn, patched, dusty at the sides, no lines
    strip('street', 7, false, (x, w) => {
      for (const lc of [1.75, 5.25]) band(x(lc), w(1.6), 0.15);
      for (let i = 0; i < 5; i++) patch(x, w, 0.2, 6.8);
      cracks(x, 0.2, 6.8, 6);
      g.fillStyle = 'rgba(150,130,100,0.3)'; g.fillRect(x(0), 0, w(0.6), H); g.fillRect(x(6.4), 0, w(0.6), H);
    });
  });
  t.wrapS = THREE.ClampToEdgeWrapping;
  return t;
}

let mats: { surface: THREE.Material; fixtures: THREE.Material; stud: THREE.Material; panel: THREE.Material } | null = null;
function roadMaterials() {
  // (the surface sits a hair back: paint and studs on it always win the depth test)
  mats ??= {
    surface: new THREE.MeshStandardMaterial({ map: roadAtlas(), vertexColors: true, roughness: 0.93, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2 }),
    fixtures: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }),
    // road studs and lit signs: unlit, never bright enough to bloom (they shine back, they are not lamps)
    stud: new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color(0.75, 0.75, 0.75) }),
    // a toll canopy's light panels: lit, a little over white (a soft glow, no glare)
    panel: new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color(1.15, 1.1, 1.0) }),
  };
  return mats;
}

/** Quads into one indexed geometry (positions relative to the chunk's origin), colours and UVs per vertex. */
class Mesher {
  p: number[] = []; c: number[] = []; u: number[] = []; i: number[] = []; n = 0;
  v(x: number, y: number, z: number, col: number[], uu = 0, vv = 0) { this.p.push(x, y, z); this.c.push(col[0], col[1], col[2]); this.u.push(uu, vv); return this.n++; }
  /** a, b along; d, c the next column (a-d across): two triangles, facing up for a left-to-right column order */
  q(a: number, b: number, c: number, d: number) { this.i.push(a, d, c, a, c, b); }
  geometry() {
    if (!this.n) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    g.setIndex(this.i);
    g.computeVertexNormals();
    return g;
  }
}

const hex = (s: string) => { const c = new THREE.Color(s); return [c.r, c.g, c.b]; };
const EARTH = hex('#8b7a5e'), BANK = hex('#6e6a48'), SOIL = hex('#5f5140'), CONCRETE = hex('#b5afa4'), DECK = hex('#8f8a82');
const KERB_Y = hex('#e2b21c'), KERB_K = hex('#1d1d1d'), WHITE = hex('#e8e7e1'), RAIL = hex('#a9afb3');
const STEP = 5;

/**
 * A toll plaza at s (m along the line) across a highway: on each carriageway (widened to TOLL_W) islands between
 * its booth lanes, a booth on each island, a canopy over the lot on columns with a lit fascia and lights under it,
 * a signal over each lane (green arrow; one lane closed, red cross); rumble strips before it. Barriers: the
 * traffic's (they lift for each vehicle). Only the parts inside [s0, s1) of this piece.
 */
function tollPlaza(st: number, at: (s: number, lat: number, dy: number) => { x: number; y: number; z: number; ry: number }, b: FastBatch, s0: number, s1: number,
  inner: number, paintBox: (s: number, lat: number, lenAlong: number, wAcross: number, col: number[], dy?: number, h?: number) => void) {
  const inRange = (s: number) => s >= s0 && s < s1;
  const box = (s: number, lat: number, dy: number, lx: number, h: number, lz: number, col: string, key = 'fixtures') => {
    if (!inRange(s)) return;
    const p = at(s, lat, dy);
    b.box(lx, h, lz, mat(p.x, p.y + h / 2, p.z, p.ry), col, key);
  };
  const edge = inner + TOLL_W;
  for (const e of [-1, 1] as const) {
    // islands at the plaza (from the carriageway's inner edge out), kerbed, striped at the noses; a booth on each
    for (let n = 0; n <= TOLL.lanes; n++) {
      const m = TOLL.island / 2 + n * (TOLL.lane + TOLL.island), lat = e * (inner - 0.5 + m);
      // (dir +1 drives the negative side, toward +s: its booths at the island's far end)
      const dir = -e;
      for (let k = -9; k <= 9; k++) box(st + k * 1.2, lat, 0, 1.2, 0.25, TOLL.island, Math.abs(k) >= 8 ? (k % 2 ? '#1d1d1d' : '#e2b21c') : '#c9c4b8');
      if (n === 0 || n === TOLL.lanes) continue;
      box(st + dir * 3, lat, 0.25, 2.2, 2.6, 0.9, '#efe9dc');
      box(st + dir * 3, lat, 2.85, 2.5, 0.2, 1.1, '#2e4a62');
      box(st + dir * 3, lat, 1.2, 1.3, 0.8, 0.95, '#22313d');                                   // its window
      box(st + dir * 3 - dir * 1.5, lat, 0, 0.25, 1.0, 0.25, '#3d3d3d');                         // barrier post
    }
    // lane signals over each lane on the canopy's edge: green arrows, the outermost lane closed now and then
    for (let n = 0; n < TOLL.lanes; n++) {
      const lat = e * (inner - 0.5 + TOLL.island + n * (TOLL.lane + TOLL.island) + TOLL.lane / 2);
      const closed = n === TOLL.lanes - 1 && hash2(Math.floor(st), e, 77) < 0.5;
      box(st + e * 10.2, lat, 6.15, 0.15, 0.7, 0.7, '#111111');
      box(st + e * 10.3, lat, 6.25, 0.08, 0.5, 0.5, closed ? '#ff2a2a' : '#2dff6a', 'stud');
    }
    // rumble strips on the approach (dir +1 approaches from smaller s)
    const dir = -e;
    for (const back of [140, 230, 320]) for (let n = 0; n < 6; n++) {
      const s = st - dir * (back + n * 0.9);
      if (inRange(s)) paintBox(s, e * (inner + SECTION.nh.lane), 0.25, 2 * SECTION.nh.lane, [0.92, 0.92, 0.9], 0.015, 0.012);
    }
  }
  // the canopy: columns on the islands, a deck over both carriageways, its lit fascia and lights under it
  for (const e of [-1, 1]) for (let n = 0; n <= TOLL.lanes; n += 2) for (const ds of [-8, 8]) box(st + ds, e * (inner - 0.5 + TOLL.island / 2 + n * (TOLL.lane + TOLL.island)), 0, 0.6, 6.0, 0.6, '#d9dcde');
  for (let w = -edge; w < edge; w += 4) {
    const wa = Math.min(4, edge - w), lat = w + wa / 2;
    box(st, lat, 6.0, 20, 0.7, wa, '#f2f3f1');
    box(st - 10.1, lat, 6.0, 0.15, 0.45, wa, '#d9a90e', 'stud');
    box(st + 10.1, lat, 6.0, 0.15, 0.45, wa, '#d9a90e', 'stud');
    for (const ds of [-5, 5]) box(st + ds, lat, 5.95, 1.6, 0.05, Math.min(1.2, wa), '#fff6dc', 'panel');
  }
}

/**
 * One km (or less) of a road: [km0, km1] inside its range. Positions are relative to the returned group's
 * position (the piece's middle).
 */
export function buildRoadPiece(route: Route, field: TerrainField, road: ParallelRoad, km0: number, km1: number): THREE.Group {
  const f = newFrame(), k = road.kind, S = SECTION[k], ph = pavedHalf(k), fh = formationHalf(k);
  const nh = k === 'nh';
  const s0 = km0 * 1000, s1 = km1 * 1000;
  // the origin: the road's centre half way
  route.alignment.sampleOffset((s0 + s1) / 2, road.offsetAt((km0 + km1) / 2), f);
  const ox = f.x, oz = f.z;
  const rows: number[] = [];
  for (let s = s0; s < s1; s += STEP) rows.push(s);
  rows.push(s1);
  const top = rows.map(s => roadTop(route, s / 1000)), cen = rows.map(s => road.offsetAt(s / 1000));
  // (a toll plaza widens each carriageway at its outer edge)
  // (a toll plaza widens each carriageway at its outer edge; a forecourt or a lay-by one side)
  const flS = { [-1]: rows.map(s => flareAt(road, s / 1000, -1)), [1]: rows.map(s => flareAt(road, s / 1000, 1)) } as Record<number, number[]>;
  const flared = (e: number, i: number) => flS[e][Math.max(0, Math.min(rows.length - 1, i))] > 0.01;
  // the roundabouts on any road here: the road's rows stop at their ring
  const rounds = parallelRoads(route).flatMap(p => p.roundabouts.map(km => ({ s: km * 1000, lat: p.offsetAt(km) })));
  const inRound = (s: number, lat: number, pad = 0) => rounds.some(q => Math.hypot(s - q.s, lat - q.lat) < ROUNDABOUT.outer - 1 + pad);
  const P = (i: number, lat: number, dy: number): [number, number, number] => {
    route.alignment.sampleOffset(rows[i], cen[i] + lat, f);
    return [f.x - ox, top[i] + dy, f.z - oz];
  };
  const at = (s: number, lat: number, dy: number) => {
    const km = s / 1000;
    route.alignment.sampleOffset(s, road.offsetAt(km) + lat, f);
    return { x: f.x - ox, y: roadTop(route, km) + dy, z: f.z - oz, ry: -f.heading };
  };

  // bridges: where a river runs under the road's centre (and 10 m either side, its abutments)
  const S0: GroundSample = { h: 0, hole: false, nt: null, river: 0, waterY: 0, road: 0, pond: 0, natural: 0 };
  // (a river reaching the road crosses the line near a railway bridge: the ground is only sampled there)
  const nearRiver = (s: number) => route.bridges.some(br => s > br.fromKm * 1000 - 350 && s < br.toKm * 1000 + 350);
  const wet = rows.map((s, i) => { if (!nearRiver(s)) return false; route.alignment.sampleOffset(s, cen[i], f); return field.sample(f.x, f.z, S0).river < 6; });
  const bridge = wet.map((_, i) => wet.slice(Math.max(0, i - 2), i + 3).some(Boolean));
  // openings in the median: the U-turn gaps and the junctions
  const openings = [...road.gaps, ...road.junctions].map(g => g * 1000);
  const open = (s: number) => nh && (openings.some(g => Math.abs(g - s) < 9) || (rounds.length > 0 && inRound(s, road.offsetAt(s / 1000), 8)));
  // wear: patched, darker stretches; a concrete stretch now and then (3 km at a time)
  const wear = rows.map(s => { const n = hash2(Math.floor(s / 25), 7, 313); return n < 0.15 ? 0.84 : 0.95 + n * 0.08; });
  const concrete = nh && hash2(Math.floor(km0 / 3), road.fromKm * 10, 571) < 0.3;

  const surface = new Mesher(), fix = new Mesher();
  /** a ribbon over the rows where `on(i)` holds: columns [lat, dy, colour, u] left to right; v along */
  const ribbon = (m: Mesher, on: (i: number) => boolean, cols: (i: number) => [number, number, number[], number][]) => {
    let prev: number[] | null = null;
    for (let i = 0; i < rows.length; i++) {
      if (!on(i) || inRound(rows[i], cen[i])) { prev = null; continue; }
      const ids = cols(i).map(([lat, dy, col, u]) => { const [x, y, z] = P(i, lat, dy); return m.v(x, y, z, col, u, rows[i] / PERIOD); });
      if (prev) for (let j = 0; j + 1 < ids.length; j++) m.q(prev[j], ids[j], ids[j + 1], prev[j + 1]);
      prev = ids;
    }
  };
  const all = () => true, dry = (i: number) => !bridge[i];
  const w = (i: number) => [wear[i], wear[i], wear[i]];
  const U = (key: keyof typeof STRIP, t: number) => STRIP[key][0] + (STRIP[key][1] - STRIP[key][0]) * t;

  // ---- the surface
  if (nh) {
    const key = concrete ? 'nhc' : 'nh', inner = S.median / 2;
    // each carriageway: its inner edge (by the median) to its outer edge; u from the inner edge out
    ribbon(surface, all, i => [[-inner - NH_W, 0, w(i), U(key, 1)], [-inner, 0, w(i), U(key, 0)]]);
    ribbon(surface, all, i => [[inner, 0, w(i), U(key, 0)], [inner + NH_W, 0, w(i), U(key, 1)]]);
    // paved across the median at its openings
    ribbon(surface, i => open(rows[i]), i => [[-inner, 0, w(i), U('street', 0.3)], [inner, 0, w(i), U('street', 0.7)]]);
  } else {
    const key = k === 'sh' ? 'sh' : 'street';
    ribbon(surface, all, i => [[-ph, 0, w(i), U(key, 0)], [ph, 0, w(i), U(key, 1)]]);
  }
  // a toll plaza's widening, a forecourt, a lay-by: concrete apron out from the carriageway
  for (const e of [-1, 1]) ribbon(surface, i => flared(e, i - 1) || flared(e, i) || flared(e, i + 1), i => {
    const c: [number, number, number[], number][] = [[e * ph, 0, w(i), U('apron', 0)], [e * (ph + flS[e][i]), 0, w(i), U('apron', Math.min(1, flS[e][i] / 4))]];
    return e < 0 ? c.reverse() : c;
  });

  // ---- earth shoulders and the embankment's sides (none on a bridge)
  for (const e of [-1, 1]) {
    const cols = (i: number): [number, number, number[], number][] => {
      // (dipping just under the ground beyond: the terrain makes the embankment's slope)
      const fl = flS[e][i];
      const c: [number, number, number[], number][] = [[e * (ph + fl), -0.02, EARTH, 0], [e * (fh + fl), -0.08, EARTH, 0], [e * (fh + fl + 1.2), -0.7, BANK, 0]];
      return e < 0 ? c.reverse() : c;
    };
    ribbon(fix, dry, cols);
  }

  const b = new FastBatch();
  // the small things (hedge tufts and flowers, trees, crash barrier posts, stones, road studs): drawn only near
  // the camera - from a few hundred metres they are less than a pixel
  const bd = new FastBatch();
  // ---- the median: soil between kerbs painted black and yellow, oleanders and bougainvillea in it
  if (nh) {
    const inner = S.median / 2;
    ribbon(fix, i => !open(rows[i]), () => [[-inner + 0.2, 0.2, SOIL, 0], [inner - 0.2, 0.2, SOIL, 0]]);
    // (the kerb's points along each edge, from the rows: every metre between them interpolated)
    const edge = (lat: number) => rows.map((_, i) => P(i, lat, 0));
    const kerbAt = (pts: [number, number, number][], s: number, dy: number) => {
      const i = Math.min(rows.length - 2, Math.max(0, Math.floor((s - s0) / STEP))), t = (s - rows[i]) / (rows[i + 1] - rows[i]);
      const a = pts[i], c = pts[i + 1];
      return { x: a[0] + (c[0] - a[0]) * t, y: a[1] + (c[1] - a[1]) * t + dy, z: a[2] + (c[2] - a[2]) * t };
    };
    const K = { [-1]: [edge(-inner), edge(-inner + 0.2)], [1]: [edge(inner), edge(inner - 0.2)] } as Record<number, [number, number, number][][]>;
    for (let s = Math.ceil(s0); s < s1; s += 1) {
      if (open(s) || open(s + 1)) continue;
      const col = Math.floor(s) % 2 ? KERB_K : KERB_Y;
      for (const e of [-1, 1]) {
        const [o, ii] = K[e], s2 = Math.min(s + 1, s1);
        const a0 = kerbAt(o, s, 0), a1 = kerbAt(o, s2, 0), b0 = kerbAt(o, s, 0.2), b1 = kerbAt(o, s2, 0.2);
        const c0 = kerbAt(ii, s, 0.2), c1 = kerbAt(ii, s2, 0.2);
        const ids = [a0, a1, b1, b0].map(p => fix.v(p.x, p.y, p.z, col));
        fix.q(ids[0], ids[1], ids[2], ids[3]);
        const t = [b0, b1, c1, c0].map(p => fix.v(p.x, p.y, p.z, col));
        fix.q(t[0], t[1], t[2], t[3]);
      }
    }
    // the hedge: a clipped run of oleander (its height and shade wandering, broken at the openings), leafy tufts
    // along its top, flowers dotted over it - pink, white and red, a bougainvillea's magenta here and there
    const rr = rng(Math.floor(km0 * 1000) + 17);
    const hh = rows.map((s, i) => 1.15 + 0.45 * hash2(Math.floor(s / 7), 3, 911) + 0.15 * Math.sin(i * 1.7));
    const LEAF = [hex('#2b4a25'), hex('#33552a'), hex('#3b5f30'), hex('#2f4f2b')];
    const leaf = rows.map(s => LEAF[Math.floor(hash2(Math.floor(s / 9), 5, 911) * LEAF.length)]);
    const hedge = (i: number) => !open(rows[i]) && !bridge[i];
    ribbon(fix, hedge, i => [[-0.75, 0.2, leaf[i], 0], [-0.55, hh[i], leaf[i], 0], [0.55, hh[i], leaf[i], 0], [0.75, 0.2, leaf[i], 0]]);
    const tuft = new THREE.IcosahedronGeometry(0.34, 0), bloom = new THREE.BoxGeometry(0.11, 0.11, 0.11);
    const flowers = ['#e0569a', '#f4f1ec', '#c2185b', '#ff7aa8', '#d61f7a'];
    for (let s = Math.ceil(s0 / 1.4) * 1.4; s < s1; s += 1.4) {
      const i = Math.min(rows.length - 1, Math.round((s - s0) / STEP));
      if (!hedge(i)) continue;
      for (const side of [-1, 1]) {
        const p = at(s + (rr() - 0.5), side * (0.35 + rr() * 0.2), hh[i] - 0.25 + rr() * 0.2);
        bd.add(tuft, mat(p.x, p.y, p.z, rr() * 6, rr(), 0, 1.3, 0.7 + rr() * 0.4, 1.1), ['#2d4f27', '#3a6131', '#456d38', '#2a4524'][Math.floor(rr() * 4)], 'fixtures');
      }
      if (rr() < 0.55) continue;
      const fc = flowers[Math.floor(rr() * flowers.length)];
      for (let n = 0; n < 4; n++) { const q = at(s + (rr() - 0.5) * 2.4, (rr() - 0.5) * 1.3, 0.5 + rr() * (hh[i] - 0.3)); bd.add(bloom, mat(q.x, q.y, q.z, rr() * 3), fc, 'fixtures'); }
    }
  }

  // ---- bridges: deck, parapets, piers down to the river bed
  for (const e of [-1, 1]) {
    const cols = (i: number): [number, number, number[], number][] => {
      const c: [number, number, number[], number][] = [[e * ph, 0, CONCRETE, 0], [e * ph, 0.95, CONCRETE, 0], [e * (ph + 0.35), 0.95, CONCRETE, 0], [e * (ph + 0.35), -1.3, DECK, 0]];
      return e < 0 ? c.reverse() : c;
    };
    ribbon(fix, i => bridge[i], cols);
  }
  ribbon(fix, i => bridge[i], () => [[-ph - 0.35, -1.3, DECK, 0], [ph + 0.35, -1.3, DECK, 0]]);
  for (let i = 0; i < rows.length; i += 4) {
    if (!bridge[i] || !bridge[Math.max(0, i - 2)] || !bridge[Math.min(rows.length - 1, i + 2)]) continue;
    for (const lat of nh ? [-7.5, -2.5, 2.5, 7.5] : [-2.5, 2.5]) {
      const p = at(rows[i], lat, -1.3);
      route.alignment.sampleOffset(rows[i], cen[i] + lat, f);
      const g = field.height(f.x, f.z) - 1.5, h = p.y - g;
      if (h > 0.5) b.cyl(0.6, 0.6, h, 10, mat(p.x, g + h / 2, p.z), '#9c968c', 'fixtures');
    }
  }

  // ---- road studs (cat's eyes) every 18 m: white on the lane lines, red on the left edge, amber by the median
  const studs = (lat: number, col: string, from = 0) => {
    for (let s = Math.ceil((s0 - from) / PERIOD) * PERIOD + from; s < s1; s += PERIOD) {
      const p = at(s, lat, 0.02);
      bd.box(0.14, 0.04, 0.12, mat(p.x, p.y, p.z, p.ry), col, 'stud');
    }
  };
  if (nh) {
    const inner = S.median / 2;
    for (const e of [-1, 1]) {
      studs(e * (inner + S.inner + S.lane), '#ffffff', 6);
      studs(e * (inner + S.inner + 2 * S.lane + 0.1), '#ff3b2f', 6);
      studs(e * (inner + 0.42), '#ffb21e', 6);
    }
  } else if (k === 'sh') { studs(0, '#ffffff', 6); for (const e of [-1, 1]) studs(e * 3.28, e < 0 ? '#ff3b2f' : '#ffffff', 6); }

  // ---- painted on the road at junctions: a zebra crossing, rumble strips before it, chevrons by the median's
  // nose (a highway), speed breakers striped yellow and black (a state highway)
  const paintBox = (s: number, lat: number, lenAlong: number, wAcross: number, col: number[], dy = 0.012, h = 0.006, rot = 0) => {
    const p = at(s, lat, dy);
    b.box(lenAlong, h, wAcross, mat(p.x, p.y, p.z, p.ry + rot), new THREE.Color(col[0], col[1], col[2]), 'fixtures');
  };
  for (const j of road.junctions) {
    const sj = j * 1000;
    if (sj < s0 - 300 || sj > s1 + 300) continue;
    const inRange = (s: number) => s >= s0 && s < s1;
    if (nh) {
      const inner = S.median / 2;
      for (const dir of [1, -1] as const) {
        // dir +1 comes up the km on the left carriageway (negative offsets)
        const side = -dir, zebra = sj - dir * 22;
        for (let m = 0.4; m < NH_W - 0.3; m += 1.0) if (inRange(zebra)) paintBox(zebra, side * (inner + m), 3, 0.5, WHITE);
        for (const back of [80, 130, 180]) for (let n = 0; n < 5; n++) {
          const s = sj - dir * (back + n * 0.9);
          if (inRange(s)) paintBox(s, side * (inner + S.inner + S.lane), 0.25, 2 * S.lane, WHITE, 0.015, 0.012);
        }
        for (let n = 1; n < 9; n++) {
          const s = sj - dir * (12 + n * 3);
          if (inRange(s)) paintBox(s, side * (inner + 0.7), 0.3, 1.3, WHITE, 0.012, 0.006, side * dir * 0.7);
        }
      }
    } else {
      for (const dir of [1, -1]) {
        const sb = sj - dir * 45;
        if (!inRange(sb)) continue;
        for (let m = -3.15; m < 3.2; m += 0.7) paintBox(sb, m + 0.35, 1.2, 0.7, Math.round((m + 3.15) / 0.7) % 2 ? KERB_K : KERB_Y, 0.04, 0.08);
      }
      for (let m = -3.2; m < 3.3; m += 0.9) if (sj >= s0 && sj < s1) paintBox(sj - 18, m, 3, 0.45, WHITE);
    }
  }

  // ---- roundabouts (where a highway meets a town street): a ring of road round a kerbed island - grass, a
  // sandstone pillar, shrubs - and a high mast lighting it
  for (const km of road.roundabouts) {
    const sc = km * 1000;
    if (sc < s0 || sc > s1) continue;
    route.alignment.sampleOffset(sc, road.offsetAt(km), f);
    const cx = f.x - ox, cz = f.z - oz, cy = roadTop(route, km), N = 40;
    const ring = (m: Mesher, r0: number, r1: number, dy0: number, dy1: number, col: (n: number) => number[], uv = false) => {
      let prev: number[] | null = null;
      for (let n = 0; n <= N; n++) {
        const a = (n / N) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
        const ids = [r0, r1].map((r, j) => m.v(cx + ca * r, cy + (j ? dy1 : dy0), cz + sa * r, col(n), uv ? U('street', j ? 0.85 : 0.15) : 0, (a * (r0 + r1)) / 2 / PERIOD));
        if (prev) m.q(prev[0], ids[0], ids[1], prev[1]);
        prev = ids;
      }
    };
    ring(surface, ROUNDABOUT.island, ROUNDABOUT.outer, 0, 0, () => [1, 1, 1], true);
    ring(fix, ROUNDABOUT.island, ROUNDABOUT.island, 0, 0.25, n => (n % 2 ? KERB_K : KERB_Y));
    ring(fix, 0, ROUNDABOUT.island, 0.25, 0.25, () => hex('#4f6f36'));
    b.box(1.2, 4.5, 1.2, mat(cx, cy + 2.5, cz), '#c8955c', 'fixtures');
    b.box(1.8, 0.4, 1.8, mat(cx, cy + 0.45, cz), '#b07f4c', 'fixtures');
    for (let n = 0; n < 6; n++) { const a = n * 1.05; b.add(new THREE.IcosahedronGeometry(0.7, 0), mat(cx + Math.cos(a) * 4.5, cy + 0.8, cz + Math.sin(a) * 4.5), '#3a6131', 'fixtures'); }
    b.cyl(0.18, 0.3, 16, 8, mat(cx + 3, cy + 8, cz + 3), '#8a9096', 'fixtures');
    for (const a of [0, 2.1, 4.2]) b.box(0.9, 0.2, 0.5, mat(cx + 3 + Math.cos(a) * 0.6, cy + 16, cz + 3 + Math.sin(a) * 0.6, -a), '#fff3c4', 'lamp');
  }

  furnish();

  // ---- toll plazas
  for (const t of road.tolls) {
    const st = t * 1000;
    if (st + TOLL.flat + TOLL.taper + 200 < s0 || st - TOLL.flat - TOLL.taper - 200 > s1) continue;
    tollPlaza(st, (s, lat, dy) => at(s, lat, dy), b, s0, s1, S.median / 2 + S.inner, paintBox);
  }

  const surf = surface.geometry(), fx = fix.geometry();
  if (surf) b.add(surf, null, '#ffffff', 'surface');
  if (fx) b.add(fx, null, '#ffffff', 'fixtures');
  const M = roadMaterials();
  const out = b.build({ surface: M.surface, fixtures: M.fixtures, stud: M.stud, panel: M.panel, lamp: materials().lamp, signs: routeSigns(route).material, pool: lampPool });
  for (const c of out.children) if (['surface', 'stud', 'panel', 'pool', 'signs'].includes(c.name)) c.castShadow = false;
  if (!bd.isEmpty()) {
    const near = bd.build({ fixtures: M.fixtures, stud: M.stud });
    for (const c of near.children) if (c.name === 'stud') c.castShadow = false;
    const lod = new THREE.LOD();
    lod.addLevel(near, 0);
    lod.addLevel(new THREE.Object3D(), isTouch ? 600 : 800);
    out.add(lod);
  }
  out.position.set(ox, 0, oz);
  return out;

  /**
   * What stands along the road: km stones (yellow-topped on a highway) and the 200 m stones between, signs for
   * each direction on its left (speed limits, warnings, the services ahead, the toll plaza, green boards at
   * junctions), bus shelters, a fuel station's pylon, lights on the median at junctions and plazas, crash barriers
   * at bridges, bends and high banks, and on the older stretches trees with their trunks painted white and red.
   */
  function furnish() {
    if (k === 'street') return;
    const signs = routeSigns(route);
    const inRange = (s: number) => s >= s0 && s < s1;
    const fl = (s: number, e: 1 | -1) => flareAt(road, s / 1000, e);
    const busyAt = (s: number, m: number) => road.junctions.some(j => Math.abs(j * 1000 - s) < m) || road.tolls.some(t => Math.abs(t * 1000 - s) < 240)
      || road.sites.some(x => x.kind !== 'busstop' && Math.abs(x.km * 1000 - s) < m + 25) || inRound(s, road.offsetAt(s / 1000), 30);
    /** a sign plate (an atlas cell) w x h m, its middle y m up, facing traffic going `dir` */
    const plate = (key: string, s: number, lat: number, y: number, pw: number, phh: number, dir: 1 | -1) => {
      const c = signs.cell(key);
      if (!c) return;
      const p = at(s, lat, y);
      const ry = p.ry - dir * Math.PI / 2;
      b.add(uvToRect(new THREE.PlaneGeometry(pw, phh), { u0: c.uv[0], v0: c.uv[1], u1: c.uv[2], v1: c.uv[3] }), mat(p.x, p.y, p.z, ry), '#ffffff', 'signs');
      // its back: grey sheet metal
      const q = at(s + dir * 0.03, lat, y);
      b.box(0.02, phh, pw, mat(q.x, q.y, q.z, p.ry), '#8d9399', 'fixtures');
    };
    /** a sign on a post at the left of traffic going dir, `back` m before s (it reads it before getting there) */
    const sign = (key: string, s: number, dir: 1 | -1, size = 0.8, tall = 2.1) => {
      if (!inRange(s)) return;
      const e = -dir as 1 | -1, lat = e * (ph + fl(s, e) + 1.3), p = at(s, lat, 0);
      b.cyl(0.04, 0.05, tall + size / 2, 6, mat(p.x, p.y + (tall + size / 2) / 2, p.z), '#9aa0a5', 'fixtures');
      plate(key, s - dir * 0.06, lat, tall + size / 2 - 0.05, size, size, dir);
    };
    const each = (fn: (dir: 1 | -1) => void) => { fn(1); fn(-1); };
    const limit = nh ? '100' : '80';

    // km stones on the side away from the line; 200 m stones between
    for (let km = Math.ceil(s0 / 200) * 0.2; km * 1000 < s1; km = Math.round(km * 5 + 1) / 5) {
      const s = km * 1000, e = road.side;
      if (busyAt(s, 30) || bridge[Math.round((s - s0) / STEP)]) continue;
      const whole = Math.abs(km - Math.round(km)) < 1e-6, lat = e * (ph + fl(s, e) + 0.9), p = at(s, lat, 0);
      if (whole) {
        bd.box(0.22, 0.74, 0.5, mat(p.x, p.y + 0.37, p.z, p.ry), '#f6f4ee', 'fixtures');
        for (const dir of [1, -1] as const) plate(stoneKey(road, Math.round(km), dir), s - dir * 0.115, lat, 0.4, 0.5, 0.625, dir);
      } else {
        bd.box(0.12, 0.36, 0.26, mat(p.x, p.y + 0.18, p.z, p.ry), '#f6f4ee', 'fixtures');
        const d = Math.round((km - Math.floor(km)) * 10);
        for (const dir of [1, -1] as const) plate(`hm-${d}`, s - dir * 0.065, lat, 0.2, 0.22, 0.22, dir);
      }
    }

    // signs
    each(dir => {
      const ahead = (km: number, m: number) => km * 1000 - dir * m;
      // speed limits: the road's, after each junction and plaza and where it starts; slower before them
      sign(`speed-${limit}`, (dir > 0 ? road.fromKm + 0.9 : road.toKm - 0.9) * 1000, dir);
      for (const j of road.junctions) {
        sign('warn-junction', ahead(j, 380), dir, 0.95);
        sign(`speed-60`, ahead(j, 260), dir);
        sign(`speed-${limit}`, ahead(j, -170), dir);
        if (hash2(Math.round(j * 100), 9, 71) < 0.4) sign('info-hospital', ahead(j, 470), dir);
        if (!nh) {
          sign('warn-breaker', ahead(j, 160), dir, 0.95);
          if (hash2(Math.round(j * 100), 10, 71) < 0.5) sign('warn-school', ahead(j, 230), dir, 0.95);
        }
        // the green board: the town ahead on the line, the village up the side road
        const sb = ahead(j, 330);
        if (inRange(sb)) {
          const e = -dir as 1 | -1, lat = e * (ph + fl(sb, e) + 2.2);
          for (const d of [-1.3, 1.3]) { const q = at(sb, lat + e * d, 0); b.cyl(0.06, 0.07, 4, 6, mat(q.x, q.y + 2, q.z), '#9aa0a5', 'fixtures'); }
          plate(boardKey(road, j, dir), sb - dir * 0.08, lat, 3.2, 3.4, 1.7, dir);
        }
      }
      for (const t of road.tolls) {
        // the plaza ahead (a wide board on two posts), slow down to it, the road's speed after it
        const sb = ahead(t, 520);
        if (inRange(sb)) {
          const e = -dir as 1 | -1, lat = e * (ph + fl(sb, e) + 1.8);
          for (const d of [-0.8, 0.8]) { const q = at(sb, lat + e * d, 0); b.cyl(0.05, 0.06, 3, 6, mat(q.x, q.y + 1.5, q.z), '#9aa0a5', 'fixtures'); }
          plate('toll-500', sb - dir * 0.06, lat, 2.7, 2.0, 1.0, dir);
        }
        sign('speed-40', ahead(t, 330), dir);
        sign(`speed-${limit}`, ahead(t, -300), dir);
      }
      for (const g of road.gaps) sign('info-uturn', ahead(g, 140), dir);
      for (const x of road.sites) {
        if (x.kind === 'petrol') sign('info-petrol', ahead(x.km, 600), dir);
        if (x.kind === 'dhaba' || x.kind === 'tea') sign('info-food', ahead(x.km, 600), dir);
        if (x.kind === 'market') { sign('speed-40', ahead(x.km, 280), dir); sign('warn-school', ahead(x.km, 360), dir, 0.95); }
      }
      // where it turns away from the line: the bend's warning
      const bendKm = dir > 0 ? road.toKm - 0.7 : road.fromKm + 0.7;
      if (!road.roundabouts.some(r => Math.abs(r - (dir > 0 ? road.toKm : road.fromKm)) < 0.01)) sign(road.side === -dir ? 'warn-curve-l' : 'warn-curve-r', ahead(bendKm, 160), dir, 0.95);
      if (!nh) for (let km = Math.ceil(road.fromKm) + 0.5; km < road.toKm; km += 2) if (hash2(Math.round(km * 10), dir + 2, 73) < 0.35) sign('warn-cattle', km * 1000, dir, 0.95);
    });

    // bus stops: a shelter just past the junction on the left, its sign on a post
    for (const x of road.sites) {
      if (x.kind !== 'busstop') continue;
      const s = x.km * 1000;
      if (!inRange(s)) continue;
      const e = x.side, lat = e * (ph + fl(s, e) + 3.0), ry = at(s, lat, 0).ry;
      const L = (dl: number, ds: number, y: number) => at(s + ds, lat + e * dl, y);
      const back = L(0.8, 0, 1.2); b.box(3.2, 2.4, 0.12, mat(back.x, back.y, back.z, ry), '#d8d4c8', 'fixtures');
      const roof = L(0.1, 0, 2.45); b.box(3.7, 0.12, 2.0, mat(roof.x, roof.y, roof.z, ry, e * 0.06), '#2e6fa8', 'fixtures');
      for (const ds of [-1.5, 1.5]) { const q = L(-0.75, ds, 1.2); b.box(0.1, 2.4, 0.1, mat(q.x, q.y, q.z, ry), '#7d858c', 'fixtures'); }
      const bench = L(0.45, 0, 0.45); b.box(2.6, 0.07, 0.42, mat(bench.x, bench.y, bench.z, ry), '#7b5a3c', 'fixtures');
      sign('info-bus', s + (e < 0 ? -1 : 1) * 3, (e < 0 ? 1 : -1) as 1 | -1, 0.7);
    }
    // a fuel station's pylon by the road with its (made-up) brand
    for (const x of road.sites) {
      if (x.kind !== 'petrol') continue;
      const s = x.km * 1000 - 28;
      if (!inRange(s)) continue;
      const e = x.side, lat = e * (ph + fl(s, e) + 2), p = at(s, lat, 0);
      b.box(0.35, 7, 0.35, mat(p.x, p.y + 3.5, p.z, p.ry), '#8a9096', 'fixtures');
      for (const dir of [1, -1] as const) plate('brand-fuel', s - dir * 0.2, lat, 6.6, 1.6, 2.1, dir);
    }

    // median lights at junctions, plazas and the market: tall poles with an arm over each carriageway, a pool of
    // light under each lamp
    if (nh) {
      const lit = (s: number) => road.junctions.some(j => Math.abs(j * 1000 - s) < 280) || road.tolls.some(t => Math.abs(t * 1000 - s) < 260 && Math.abs(t * 1000 - s) > 25)
        || road.sites.some(x => x.kind === 'market' && Math.abs(x.km * 1000 - s) < 260);
      for (let s = Math.ceil(s0 / 36) * 36; s < s1; s += 36) {
        if (!lit(s) || open(s)) continue;
        const p = at(s, 0, 0.2);
        b.cyl(0.11, 0.17, 10, 8, mat(p.x, p.y + 5, p.z), '#8a9096', 'fixtures');
        for (const e of [-1, 1]) {
          const a = at(s, e * 1.2, 10), h = at(s, e * 2.3, 9.9), g = at(s, e * (S.median / 2 + 4.5), 0.03);
          b.box(0.08, 0.08, 2.4, mat(a.x, a.y, a.z, a.ry), '#8a9096', 'fixtures');
          b.box(0.6, 0.14, 0.3, mat(h.x, h.y, h.z, h.ry), '#ffffff', 'lamp');
          b.add(new THREE.PlaneGeometry(14, 14), mat(g.x, g.y, g.z, g.ry, -Math.PI / 2), '#ffffff', 'pool');
        }
      }
    }

    // crash barriers (galvanised W-beam on posts, a reflector every 4 m): bridge approaches, bends, high banks
    const S1: GroundSample = { h: 0, hole: false, nt: null, river: 0, waterY: 0, road: 0, pond: 0, natural: 0 };
    for (const e of [-1, 1] as const) {
      // (the bank's height checked every 20 m)
      let high = false;
      const need = rows.map((s, i) => {
        if (i % 4 === 0) { route.alignment.sampleOffset(s, cen[i] + e * (fh + 4), f); high = top[i] - field.sample(f.x, f.z, S1).natural > 2.4; }
        if (bridge[i] || flared(e, i)) return false;
        const nearBridge = bridge.some((v, j) => v && Math.abs(j - i) <= 12);
        const bend = i > 0 && i < rows.length - 1 && Math.abs(cen[i + 1] - cen[i - 1]) / (2 * STEP) > 0.1;
        return nearBridge || bend || high;
      });
      const lat = (i: number) => e * (ph + flS[e][i] + 0.45);
      ribbon(fix, i => need[i], i => { const c: [number, number, number[], number][] = [[lat(i), 0.42, RAIL, 0], [lat(i), 0.78, RAIL, 0]]; return c; });
      for (let i = 0; i < rows.length; i++) {
        if (!need[i]) continue;
        for (let d = 0; d < STEP; d += 2) {
          const s = rows[i] + d;
          if (s >= s1) break;
          const p = at(s, lat(i) + e * 0.12, 0);
          bd.box(0.1, 0.8, 0.1, mat(p.x, p.y + 0.4, p.z, p.ry), '#7d858c', 'fixtures');
          if (d === 0) { const q = at(s, lat(i) - e * 0.03, 0.6); bd.box(0.1, 0.08, 0.03, mat(q.x, q.y, q.z, q.ry), '#ffb21e', 'stud'); }
        }
      }
    }

    // trees along the older stretches (a state highway's, some of a highway's), their trunks painted for the night
    const older = (s: number) => !nh || hash2(Math.floor(s / 1000), 13, 977) < 0.45;
    const rt = rng(Math.floor(s0) + 3);
    const crown = new THREE.IcosahedronGeometry(1.7, 0);
    for (const e of [-1, 1] as const) for (let s = Math.ceil(s0 / 15) * 15; s < s1; s += 15) {
      const ss = s + (rt() - 0.5) * 5, i = Math.max(0, Math.min(rows.length - 1, Math.round((ss - s0) / STEP)));
      if (!older(ss) || busyAt(ss, 45) || bridge[i] || flared(e, i) || rt() < 0.15) continue;
      const p = at(ss, e * (fh + flS[e][i] + 4 + rt() * 2), -0.3), sc = 0.8 + rt() * 0.5;
      bd.cyl(0.2 * sc, 0.26 * sc, 3.4 * sc, 7, mat(p.x, p.y + 1.7 * sc, p.z), '#5b4330', 'fixtures');
      bd.cyl(0.275 * sc, 0.275 * sc, 1.0, 7, mat(p.x, p.y + 0.5, p.z), '#f2f0ea', 'fixtures');
      bd.cyl(0.28 * sc, 0.28 * sc, 0.22, 7, mat(p.x, p.y + 1.1, p.z), '#c0392b', 'fixtures');
      for (let n = 0; n < 3; n++) bd.add(crown, mat(p.x + (rt() - 0.5) * 2.2 * sc, p.y + (3.6 + rt() * 1.2) * sc, p.z + (rt() - 0.5) * 2.2 * sc, rt() * 6, 0, 0, sc, sc * 0.8, sc), ['#3d5f2e', '#4a6b35', '#56773c'][n], 'fixtures');
    }
  }
}
