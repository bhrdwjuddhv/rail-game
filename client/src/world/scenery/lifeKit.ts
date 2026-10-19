import TEXTURES from '../../../../data/textures.json';

/**
 * The "life" texture packs (data/textures.json, type pack: several source atlases' cells in one texture, one
 * draw for all of them): which cell is where. No three.js here (the placement worker uses it too). Empty when a
 * pack has not been processed (`npm run textures`): every user then keeps its procedural look.
 */
export type LifePack = 'life/cutout-pack' | 'life/solid-pack' | 'life/fabric-pack' | 'life/vehicle-pack' | 'life/festival-pack';
export interface LifeCell { uv: [number, number, number, number]; aspect: number }

type Processed = { cells: number[][]; names: Record<string, [number, number]>; aspect: number[] };
export function lifeCells(pack: LifePack, name: string): LifeCell[] {
  const p = (TEXTURES.textures as unknown as Record<string, { processed?: Processed }>)[pack]?.processed;
  const range = p?.names?.[name];
  if (!p || !range) return [];
  return Array.from({ length: range[1] }, (_, i) => ({ uv: p.cells[range[0] + i] as LifeCell['uv'], aspect: p.aspect[range[0] + i] }));
}

/** cells not to be drawn: the wall stencils' national flag, a kite in its colours (no political imagery) */
export const STENCIL_SKIP = new Set([4]);
export const KITE_SKIP = new Set([8]);

/** A cell picked by a seeded draw r (0..1), skipping some; undefined if the pack is missing. */
export function pickCell(pack: LifePack, name: string, r: number, skip?: Set<number>) {
  const all = lifeCells(pack, name).map((c, i) => ({ c, i })).filter(({ i }) => !skip?.has(i));
  return all.length ? all[Math.floor(r * all.length) % all.length].c : undefined;
}

/** variants of the street props drawn from the packs (fixed per variant, picked per object in placement) */
export const SHOP_VARIANTS = 8, PAINT_VARIANTS = 8, PERSON_VARIANTS = 12;
