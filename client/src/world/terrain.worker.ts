/// <reference lib="webworker" />
import { hash2, lerp } from '@rail/shared/util';
import { Route, RegionData, RouteData } from '@rail/shared/track/Route';
import { GroundSample, TerrainField } from './TerrainField';
import { placeScenery, TileInfo } from './scenery/Placement';

// Builds terrain tiles (heights, normals, colours, holes) and scenery instance
// lists off the main thread.

export interface TileRequest { type: 'tile'; id: number; x0: number; z0: number; size: number; res: number; scenery: 'full' | 'impostor' | 'none'; grass: number }

let field: TerrainField;
let route: Route;
const S: GroundSample = { h: 0, hole: false, nt: null, river: 0, road: 0, pond: 0, natural: 0 };

const hex = (s: string): [number, number, number] => {
  const n = parseInt(s.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
let plains: RegionData, ghats: RegionData;

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'init') {
    route = new Route(m.route as RouteData, m.regions as Record<string, RegionData>);
    field = new TerrainField(route);
    const regs = Object.values(route.regions);
    plains = regs.find(r => r.sideSlope === 0) ?? regs[0];
    ghats = regs.find(r => r.sideSlope > 0) ?? regs[0];
    (self as any).postMessage({ type: 'ready' });
    return;
  }
  if (m.type === 'tile') buildTile(m as TileRequest);
};

function buildTile(req: TileRequest) {
  const { x0, z0, size, res } = req;
  const W = res + 1, B = res + 3; // B: with 1-vertex border for normals
  const cell = size / res;
  const hb = new Float32Array(B * B);
  const N = W * W;
  const info: TileInfo = {
    x0, z0, size, res,
    h: new Float32Array(N), dist: new Float32Array(N), km: new Float32Array(N), d: new Float32Array(N), heading: new Float32Array(N),
    road: new Float32Array(N), water: new Uint8Array(N), slope: new Float32Array(N),
  };
  const hole = new Uint8Array(N);
  const nat = new Float32Array(N);
  const riverD = new Float32Array(N);
  const pondD = new Float32Array(N);

  for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) {
    const x = x0 + (i - 1) * cell, z = z0 + (j - 1) * cell;
    field.sample(x, z, S);
    hb[j * B + i] = S.h;
    if (i >= 1 && j >= 1 && i <= W && j <= W) {
      const k = (j - 1) * W + (i - 1);
      info.h[k] = S.h;
      info.dist[k] = S.nt ? S.nt.dist : 9999;
      info.km[k] = S.nt ? S.nt.km : field.kmAt(x, z);
      info.d[k] = S.nt ? S.nt.d : 0;
      info.heading[k] = S.nt ? S.nt.heading : 0;
      info.road[k] = S.road;
      riverD[k] = S.river;
      pondD[k] = S.pond;
      nat[k] = S.natural;
      hole[k] = S.hole ? 1 : 0;
      let wet = S.pond < 1;
      for (const r of route.rivers) if (S.river < r.width / 2 + 2) wet = true;
      info.water[k] = wet ? 1 : 0;
    }
  }

  // geometry: grid + skirt
  const skirtN = res * 4;
  const vCount = N + skirtN + 4;
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const col = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  // UVs continuous across tiles (wrapped every 6 km to keep float precision), so
  // the large-scale anti-tiling mask in the terrain shader has no seams at tile edges
  const uo = ((x0 / 6) % 1000 + 1000) % 1000, vo = ((z0 / 6) % 1000 + 1000) % 1000;

  for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i;
    const bi = (j + 1) * B + (i + 1);
    const nx = hb[bi - 1] - hb[bi + 1], nz = hb[bi - B] - hb[bi + B], ny = 2 * cell;
    const L = Math.hypot(nx, ny, nz);
    pos[k * 3] = i * cell; pos[k * 3 + 1] = info.h[k]; pos[k * 3 + 2] = j * cell;
    nor[k * 3] = nx / L; nor[k * 3 + 1] = ny / L; nor[k * 3 + 2] = nz / L;
    info.slope[k] = 1 - ny / L;
    uv[k * 2] = uo + (i * cell) / 6; uv[k * 2 + 1] = vo + (j * cell) / 6;
    const c = colourAt(x0 + i * cell, z0 + j * cell, info, k, nat[k], riverD[k], pondD[k], ny / L);
    col[k * 3] = c[0]; col[k * 3 + 1] = c[1]; col[k * 3 + 2] = c[2];
  }

  const idx: number[] = [];
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
    const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
    if (hole[a] || hole[b] || hole[c] || hole[d]) continue;
    idx.push(a, c, b, b, c, d);
  }
  // skirts hide cracks between tiles of different resolution
  let v = N;
  const edge = (list: number[], flip: boolean) => {
    const start = v;
    for (const k of list) {
      pos[v * 3] = pos[k * 3]; pos[v * 3 + 1] = pos[k * 3 + 1] - 12; pos[v * 3 + 2] = pos[k * 3 + 2];
      nor[v * 3 + 1] = 1; col.set(col.subarray(k * 3, k * 3 + 3), v * 3); uv[v * 2] = uv[k * 2]; uv[v * 2 + 1] = uv[k * 2 + 1];
      v++;
    }
    for (let n = 0; n < list.length - 1; n++) {
      const a = list[n], b = list[n + 1], c = start + n, d = start + n + 1;
      if (flip) idx.push(a, b, c, b, d, c); else idx.push(a, c, b, b, c, d);
    }
  };
  const top: number[] = [], bottom: number[] = [], left: number[] = [], right: number[] = [];
  for (let i = 0; i < W; i++) { top.push(i); bottom.push(res * W + i); left.push(i * W); right.push(i * W + res); }
  edge(top, false); edge(bottom, true); edge(left, true); edge(right, false);

  const props = req.scenery === 'none' ? {} : placeScenery(field, route, info, req.scenery, req.grass);

  // ponds whose centre lies in this tile
  const ponds: { x: number; z: number; r: number; level: number }[] = [];
  for (let cx = Math.floor(x0 / 500); cx <= Math.floor((x0 + size) / 500); cx++)
    for (let cz = Math.floor(z0 / 500); cz <= Math.floor((z0 + size) / 500); cz++) {
      const p = field.pondFor(cx, cz);
      if (p && p.x >= x0 && p.x < x0 + size && p.z >= z0 && p.z < z0 + size) ponds.push(p);
    }

  const indices = new Uint32Array(idx);
  const transfer: Transferable[] = [pos.buffer, nor.buffer, col.buffer, uv.buffer, indices.buffer];
  for (const a of Object.values(props)) transfer.push((a as Float32Array).buffer);
  (self as any).postMessage({ type: 'tile', id: req.id, pos, nor, col, uv, indices, props, ponds, vCount: v }, transfer);
}

const GRAVEL = hex('#7b7266');
const SAND = hex('#bfae84');
const MUD = hex('#6e5b43');
const ROCK = hex('#7a756c');
const DUST = hex('#a09178');
const ROAD = hex('#4a4744');
const LATERITE = hex('#8d5a3c');
const PITCH = hex('#c7ab78');
const OUTFIELD = hex('#5d9a3a');

function colourAt(x: number, z: number, info: TileInfo, k: number, natural: number, river: number, pond: number, ny: number): [number, number, number] {
  const km = info.km[k], dist = info.dist[k];
  const g = field.ghatAt(km);
  const n = hash2(Math.floor(x / 23), Math.floor(z / 23), 5);
  const pg = hex(plains.ground[Math.floor(n * plains.ground.length)]);
  const gg = hex(ghats.ground[Math.floor(n * ghats.ground.length)]);
  let c: [number, number, number] = [lerp(pg[0], gg[0], g), lerp(pg[1], gg[1], g), lerp(pg[2], gg[2], g)];
  const zone = dist < 1800 ? route.zoneAt(km).zone : g > 0.5 ? 'ghats' : 'fields';
  const mix = (o: [number, number, number], t: number) => { c = [lerp(c[0], o[0], t), lerp(c[1], o[1], t), lerp(c[2], o[2], t)]; };

  if ((zone === 'fields' || zone === 'village') && dist > 22) {
    // rectangular fields aligned to a slightly rotated grid, with bunds
    const a = 0.35 + Math.floor(x / 900) * 0.0 + hash2(Math.floor(x / 900), Math.floor(z / 900), 2) * 0.8;
    const ca = Math.cos(a), sa = Math.sin(a);
    const u = x * ca + z * sa, w = -x * sa + z * ca;
    const fu = Math.floor(u / 64), fw = Math.floor(w / 42);
    const crops = (g > 0.5 ? ghats : plains).crops;
    const crop = hex(crops[Math.floor(hash2(fu, fw, 9) * crops.length)].color);
    const bu = Math.abs(u / 64 - fu - 0.5) > 0.47 || Math.abs(w / 42 - fw - 0.5) > 0.46;
    mix(crop, bu ? 0.2 : 0.85);
  }
  if (zone === 'town' || zone === 'colony') mix(DUST, 0.5);
  if (zone === 'ghats' && dist < 120) mix(LATERITE, 0.18);
  for (const gr of field.grounds) {
    const dg = Math.hypot(x - gr.x, z - gr.z);
    if (dg < gr.r) {
      const lx = (x - gr.x) * Math.cos(gr.heading) + (z - gr.z) * Math.sin(gr.heading);
      const lz = -(x - gr.x) * Math.sin(gr.heading) + (z - gr.z) * Math.cos(gr.heading);
      mix(Math.abs(lx) < 11 && Math.abs(lz) < 1.6 ? PITCH : OUTFIELD, 0.9);
    }
  }
  const W = dist < 300 ? route.formationHalfWidth(km) : 0;
  if (dist < W + 1.5) mix(GRAVEL, 0.92);
  else if (dist < W + 60 && Math.abs(info.h[k] - natural) > 0.4) mix(g > 0.5 ? LATERITE : MUD, 0.55);
  if (ny < 0.72) mix(ROCK, Math.min(1, (0.72 - ny) * 4));
  for (const r of route.rivers) if (river < r.width / 2 + 25) mix(SAND, river < r.width / 2 ? 0.95 : 0.6);
  if (pond < 4) mix(MUD, 0.8);
  if (info.road[k] < 4.2) mix(ROAD, 0.9);
  return c;
}
