import * as THREE from 'three/webgpu';
import { clamp, fbm, ridged } from '@rail/shared/util';
import type { RegionData } from '@rail/shared/track/Route';

export interface HorizonProfile { deg: number; jagged: number; color: THREE.Color; snowCap: number }

/** Regions without a horizon in their data: a sensible one for their landscape type. */
const BY_BIOME: Record<string, RegionData['horizon']> = {
  plains: { deg: 0.9, jagged: 0.15, color: '#6a7866' },
  ghats: { deg: 3.6, jagged: 0.55, color: '#4a6046' },
  desert: { deg: 0.7, jagged: 0.3, color: '#9c8668' },
  hills: { deg: 2.2, jagged: 0.7, color: '#76685a' },
  coast: { deg: 0.25, jagged: 0.1, color: '#7c8a86' },
  snow: { deg: 7.5, jagged: 0.95, color: '#56606c', snowCap: 0.5 },
};
export const horizonOf = (r: RegionData, biome: string) => r.horizon ?? BY_BIOME[biome] ?? BY_BIOME.plains!;

const N = 192;
// rows from the foot up: below the ground, the range's flank, the snow line, the crest
const ROWS = 4;

/**
 * The far horizon: two rings of mountain silhouettes just beyond the last
 * terrain tile, so the land never simply ends at the draw distance. The near
 * range is lower and darker, the far range higher and lost in the haze. They
 * follow the camera (too far away for parallax to matter), take their shape
 * from the region the camera is in, and are recoloured toward the fog colour.
 */
export class Horizon {
  readonly group = new THREE.Group();
  private layers: { mesh: THREE.Mesh; pos: Float32Array; col: Float32Array; scale: number; seed: number; haze: number; dark: number }[] = [];
  private profile: HorizonProfile | null = null;
  private recolour = 0;
  private radius = 0;

  constructor() {
    this.group.name = 'horizon';
    for (const [scale, seed, haze, dark] of [[1, 3, 0.62, 1], [0.78, 11, 0.38, 0.72]] as const) {
      const pos = new Float32Array(N * ROWS * 3), col = new Float32Array(N * ROWS * 3), idx: number[] = [];
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N;
        for (let r = 0; r < ROWS - 1; r++) {
          const a = i * ROWS + r, b = j * ROWS + r;
          idx.push(a, b, a + 1, b, b + 1, a + 1);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.setIndex(idx);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide }));
      mesh.frustumCulled = false;
      mesh.renderOrder = -5; // drawn before the terrain in front of it; the sky dome is -10
      this.group.add(mesh);
      this.layers.push({ mesh, pos, col, scale, seed, haze, dark });
    }
  }

  /** Blend of the regions around the camera (weights sum to 1). */
  static blend(list: { r: RegionData; w: number; biome: string }[]): HorizonProfile {
    let deg = 0, jagged = 0, snowCap = 0;
    const color = new THREE.Color(0, 0, 0), c = new THREE.Color();
    for (const { r, w, biome } of list) {
      const h = horizonOf(r, biome)!;
      deg += h.deg * w; jagged += h.jagged * w; snowCap += (h.snowCap ?? 0) * w;
      color.add(c.set(h.color).multiplyScalar(w));
    }
    return { deg, jagged, color, snowCap };
  }

  /**
   * cam: camera position; ground: ground height under it; radius: just beyond the
   * terrain's draw distance; fogColor / light: the air's colour and the daylight (0..1).
   */
  update(dt: number, cam: THREE.Vector3, ground: number, radius: number, p: HorizonProfile, fogColor: THREE.Color, light: number) {
    this.group.position.set(cam.x, ground, cam.z);
    const changed = !this.profile || Math.abs(this.profile.deg - p.deg) > 0.02 || Math.abs(this.profile.jagged - p.jagged) > 0.02 || Math.abs(this.profile.snowCap - p.snowCap) > 0.01 || Math.abs(this.radius - radius) > 20;
    if (changed) { this.profile = { ...p, color: p.color.clone() }; this.radius = radius; this.build(); }
    this.recolour -= dt;
    if (changed || this.recolour <= 0) { this.recolour = 0.4; this.paint(p.color, fogColor, light); }
  }

  /** Crest heights round the ring (seamless: noise sampled on a circle), per layer. */
  private build() {
    const p = this.profile!, R = this.radius;
    for (const L of this.layers) {
      const r = R * L.scale, top = Math.tan(THREE.MathUtils.degToRad(p.deg)) * r * (L.scale < 1 ? 0.62 : 1);
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2, cx = Math.cos(a), sz = Math.sin(a);
        const soft = fbm(cx * 2.2 + L.seed, sz * 2.2, 4, L.seed) * 0.5 + 0.5;
        const sharp = ridged(cx * 3.4 + L.seed, sz * 3.4, 5, L.seed + 1);
        // massifs and gaps: the range rises and falls round the horizon
        const mass = clamp(fbm(cx * 0.9 + L.seed * 0.3, sz * 0.9, 2, L.seed + 2) * 1.1 + 0.6, 0.15, 1.2);
        const crest = Math.max(0, top * mass * (soft * (1 - p.jagged) + sharp * p.jagged * 1.35));
        const ys = [-top * 0.6 - 60, crest * 0.45, crest * (1 - Math.max(0.03, p.snowCap * (0.6 + 0.4 * soft))), crest];
        for (let k = 0; k < ROWS; k++) L.pos.set([cx * r, ys[k], sz * r], (i * ROWS + k) * 3);
      }
      (L.mesh.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  private paint(rock: THREE.Color, fogColor: THREE.Color, light: number) {
    const p = this.profile!;
    const snow = new THREE.Color(0.93, 0.95, 0.98), c = new THREE.Color();
    for (const L of this.layers) {
      const lit = 0.18 + light * 0.82;
      for (let i = 0; i < N; i++) for (let k = 0; k < ROWS; k++) {
        // foot fully in the haze; the crest keeps most of its colour; snow above the snow line
        const base = k === ROWS - 1 && p.snowCap > 0 ? snow : rock;
        const haze = k === 0 ? 1 : L.haze * (k === 1 ? 1.15 : 0.95);
        c.copy(base).multiplyScalar(lit * L.dark).lerp(fogColor, clamp(haze, 0, 1));
        L.col.set([c.r, c.g, c.b], (i * ROWS + k) * 3);
      }
      (L.mesh.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    }
  }
}
