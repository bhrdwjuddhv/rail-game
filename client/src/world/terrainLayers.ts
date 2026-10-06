/**
 * Terrain texture layers: the order of the layers in the terrain texture array.
 * Shared by the terrain worker (per-vertex weights) and the terrain shader.
 * Each maps to a material name in data/textures.json ("terrain:<name>").
 */
export const LAYERS = ['grass', 'soil', 'forest', 'mud', 'mustard', 'paddy', 'laterite', 'sand', 'rock', 'wheat', 'formation'] as const;
export type LayerName = (typeof LAYERS)[number];
export const LAYER = Object.fromEntries(LAYERS.map((n, i) => [n, i])) as Record<LayerName, number>;
export const LAYER_COUNT = LAYERS.length;
