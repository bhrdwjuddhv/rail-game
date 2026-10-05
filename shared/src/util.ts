// Small pure helpers shared by sim, worker and render code. No three.js imports here.

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const approach = (v: number, target: number, rate: number, dt: number) => {
  const d = target - v;
  const s = rate * dt;
  return Math.abs(d) <= s ? target : v + Math.sign(d) * s;
};
export const KMPH = 1 / 3.6;
export const G = 9.81;

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer hash of 2 ints -> [0,1). */
export function hash2(x: number, y: number, seed = 0) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** 2D value noise with smooth interpolation, range ~[-1,1]. */
export function noise2(x: number, y: number, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
}

export function fbm(x: number, y: number, octaves = 4, seed = 0) {
  let s = 0, amp = 0.5, f = 1;
  for (let i = 0; i < octaves; i++) {
    s += noise2(x * f, y * f, seed + i * 17) * amp;
    f *= 2.03;
    amp *= 0.5;
  }
  return s;
}

/** Ridged noise for mountain crests, range ~[0,1]. */
export function ridged(x: number, y: number, octaves = 4, seed = 0) {
  let s = 0, amp = 0.5, f = 1;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise2(x * f, y * f, seed + i * 31));
    s += n * n * amp;
    f *= 2.1;
    amp *= 0.5;
  }
  return s;
}

/** "HH:MM" -> seconds since midnight. */
export function parseClock(s: string) {
  const [h, m] = s.split(':').map(Number);
  return h * 3600 + m * 60;
}

export function formatClock(sec: number, withSeconds = false) {
  const t = ((Math.floor(sec) % 86400) + 86400) % 86400;
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return withSeconds ? `${p(h)}:${p(m)}:${p(s)}` : `${p(h)}:${p(m)}`;
}
