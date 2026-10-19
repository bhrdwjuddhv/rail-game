import BUILDINGS from '../../../../data/buildings.json';
import TEXTURES from '../../../../data/textures.json';
import { hash2 } from '@rail/shared/util';

/**
 * Town buildings from the facade atlases (data/buildings.json): the layout of every variant, shared by the
 * placement worker (footprints, which buildings go where) and Props (the geometry). No three.js here.
 *
 * A building is its atlas cell's front (a cut-out card: the whole drawing, with its water tank, rods,
 * sunshades and drawn roof) in front of a block the size of the cell's solid body, in the body's colour,
 * topped by its style's roof. Each cell has VARIANTS variants: another depth and other roof clutter.
 */
export type BuildingStyle = keyof typeof BUILDINGS.styles;
export type BuildingKind = 'house' | 'shop' | 'construction' | 'wall' | 'tower';
export const STYLES = Object.keys(BUILDINGS.styles) as BuildingStyle[];
export const VARIANTS = 2;
export const CELLS = 16;

export const buildingType = (style: BuildingStyle, cell: number, variant: number) => `bld-${style}-${cell}-${variant}` as const;
export type BuildingType = ReturnType<typeof buildingType>;
export const BUILDING_TYPES: BuildingType[] = STYLES.flatMap(s => Array.from({ length: CELLS * VARIANTS }, (_, i) => buildingType(s, i >> 1, i & 1)));

/** the style a landscape region builds in */
export const styleOfRegion = (regionId: string): BuildingStyle => ((BUILDINGS.regions as Record<string, string>)[regionId] ?? 'plains') as BuildingStyle;
export const CITY_KM = BUILDINGS.cityKm;
export const BUILDINGS_DATA = BUILDINGS;

interface CellInfo { rect: number[]; body: number[]; colour: number[]; cap?: number[] }
type Entry = { processed?: { cellInfo?: CellInfo[] } };

/**
 * A cell's contents (UVs, v up): from `npm run textures`, else the stand-in atlas's (Textures.facadeAtlas:
 * the building from 8 % to 92 % across its cell and 4 % to 94 % up, its top 10 % a parapet).
 */
export function cellInfo(style: BuildingStyle, cell: number): CellInfo {
  const got = ((TEXTURES.textures as Record<string, Entry>)[`buildings/facades-${style}`])?.processed?.cellInfo?.[cell];
  if (got) return got;
  const c = cell % 4, r = cell >> 2, u0 = (c + 0.08) / 4, u1 = (c + 0.92) / 4, v0 = 1 - (r + 0.96) / 4, v1 = 1 - (r + 0.06) / 4;
  const pal = STANDIN_PALETTE[style][cell % STANDIN_PALETTE[style].length];
  return { rect: [u0, v0, u1, v1], body: [u0, v0, u1, v1 - (v1 - v0) * 0.1], colour: pal, cap: pal.map(v => v * 0.85) };
}

/** stand-in wall colours by style (0..1), when the atlas has not been processed */
export const STANDIN_PALETTE: Record<BuildingStyle, number[][]> = {
  plains: [[0.95, 0.75, 0.75], [0.55, 0.78, 0.95], [0.98, 0.9, 0.5], [0.72, 0.42, 0.33], [0.7, 0.88, 0.6], [0.95, 0.93, 0.86], [0.98, 0.65, 0.45], [0.7, 0.7, 0.7]],
  ghats: [[0.93, 0.9, 0.84], [0.66, 0.36, 0.26], [0.95, 0.72, 0.74], [0.98, 0.8, 0.35], [0.6, 0.8, 0.72]],
  desert: [[0.86, 0.66, 0.38], [0.95, 0.7, 0.62], [0.55, 0.65, 0.9], [0.92, 0.82, 0.62], [0.9, 0.6, 0.45]],
  himalayan: [[0.6, 0.58, 0.55], [0.95, 0.72, 0.75], [0.98, 0.8, 0.4], [0.6, 0.85, 0.78], [0.9, 0.88, 0.84]],
  city: [[0.92, 0.85, 0.72], [0.9, 0.9, 0.9], [0.95, 0.82, 0.8], [0.75, 0.82, 0.9], [0.85, 0.7, 0.6]],
};

export interface BuildingLayout {
  style: BuildingStyle; cell: number; variant: number; kind: BuildingKind; roof: 'flat' | 'hipped' | 'gable';
  /** the card: width and height (m), centred on x 0, standing on y 0; its UV rect */
  w: number; h: number; uv: number[];
  /** the block: its x extent, its height (the body's top), its depth (z, centred on 0; the card at +d/2) */
  bx0: number; bx1: number; top: number; d: number;
  /** wall and cap colours (0..1) */
  colour: number[]; cap: number[];
  /** a number 0..1 per variant, for its clutter */
  seed: number;
}

const cache = new Map<string, BuildingLayout>();
export function buildingLayout(style: BuildingStyle, cell: number, variant: number): BuildingLayout {
  const key = `${style}-${cell}-${variant}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const st = BUILDINGS.styles[style], t = st.tiles[cell], ci = cellInfo(style, cell);
  const [u0, v0, u1, v1] = ci.rect, [b0, , b1, bt] = ci.body;
  const s = t.h / (v1 - v0), w = (u1 - u0) * s;
  const kind = t.kind as BuildingKind;
  const seed = hash2(cell * 7 + variant, STYLES.indexOf(style), 431);
  const d = kind === 'wall' ? 0.35 : st.depthM[0] + (st.depthM[1] - st.depthM[0]) * hash2(cell, variant, 433 + STYLES.indexOf(style));
  const out: BuildingLayout = {
    style, cell, variant, kind, roof: st.roof as BuildingLayout['roof'],
    w, h: t.h, uv: ci.rect, bx0: (b0 - u0) * s - w / 2, bx1: (b1 - u0) * s - w / 2, top: Math.max(2.4, (bt - v0) * s), d,
    colour: ci.colour, cap: ci.cap ?? ci.colour, seed,
  };
  cache.set(key, out);
  return out;
}

/** Half footprint (x, z) of a building variant: what it stands on (Placement: the highest ground under it). */
export function buildingFootprint(style: BuildingStyle, cell: number, variant: number): [number, number] {
  const l = buildingLayout(style, cell, variant);
  return [Math.max(l.w, l.bx1 - l.bx0) / 2 + 0.1, l.d / 2 + 0.1];
}

/** The cells of a style holding this kind of building (one storey: up to `maxH` m), for the placement to pick from. */
export function cellsOf(style: BuildingStyle, kinds: BuildingKind[], maxH = Infinity) {
  return BUILDINGS.styles[style].tiles.map((t, i) => ({ t, i })).filter(({ t }) => kinds.includes(t.kind as BuildingKind) && t.h <= maxH).map(({ i }) => i);
}
