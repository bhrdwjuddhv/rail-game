import { rng } from '../util';

/**
 * Billboard advertising: the ads file (data/ads.json), checked on load, and
 * which ad each billboard shows. Pure logic (no DOM): the client builds the
 * billboards, this decides what is on them.
 *
 * frequency (0..1): how often an ad appears compared to the others. A
 * billboard picks among the ads that may run there (active, in their dates,
 * on this route / region / billboard type) with chance frequency / sum of
 * their frequencies. 0 = never shown.
 */

export type AdFormat = 'wide' | 'standard' | 'portrait' | 'screen';
export const AD_FORMATS: AdFormat[] = ['wide', 'standard', 'portrait', 'screen'];
/** width / height of each format */
export const FORMAT_ASPECT: Record<AdFormat, number> = { wide: 3, standard: 2, portrait: 0.5, screen: 16 / 9 };

export type BillboardType = 'classic' | 'wide' | 'vshape' | 'unipole' | 'rooftop' | 'platform' | 'fob' | 'led' | 'wall' | 'kiosk';
export const BILLBOARD_TYPES: BillboardType[] = ['classic', 'wide', 'vshape', 'unipole', 'rooftop', 'platform', 'fob', 'led', 'wall', 'kiosk'];
export const TYPE_FORMAT: Record<BillboardType, AdFormat> = {
  classic: 'standard', wide: 'wide', vshape: 'standard', unipole: 'wide', rooftop: 'wide',
  platform: 'standard', fob: 'wide', led: 'screen', wall: 'wide', kiosk: 'portrait',
};

export interface AdFallback { bg: string; fg: string; title: string; sub?: string }
export interface Ad {
  id: string;
  frequency: number;
  active: boolean;
  startDate?: string; endDate?: string;
  routes: string[]; regions: string[]; billboardTypes: string[];
  /** image file per format (in client/public/assets/ads/) */
  images: Partial<Record<AdFormat, string>>;
  url: string | null;
  fallback: AdFallback;
}
export interface AdSettings { billboardsPerKm: number; minGapMetres: number; sameAdMinGapMetres: number; ledPerRoute: number }
export interface AdsFile { settings: AdSettings; ads: Ad[] }

export const DEFAULT_AD_SETTINGS: AdSettings = { billboardsPerKm: 4, minGapMetres: 120, sameAdMinGapMetres: 1500, ledPerRoute: 4 };
const KNOWN_AD = new Set(['id', 'frequency', 'weight', 'active', 'startDate', 'endDate', 'routes', 'regions', 'billboardTypes', 'images', 'image', 'url', 'fallback', 'note']);
const KNOWN_SETTINGS = new Set(['billboardsPerKm', 'minGapMetres', 'sameAdMinGapMetres', 'ledPerRoute']);
const IMAGE_FILE = /^[\w\-./]+\.(jpe?g|png|webp)$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** https://host[:port][/path?query#hash]: no spaces, quotes or angle brackets */
const HTTPS_URL = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?([/?#][^\s"'<>]*)?$/i;

/**
 * Read the ads file, warning (never throwing) about anything wrong: unknown
 * fields, frequency outside 0..1, non-https links, bad image names or dates.
 * A bad ad is skipped; a bad value falls back to its default. The old format
 * (weight, image) still loads: weight is taken as the frequency (clamped to
 * 0..1) and a single image is used for every format.
 */
export function parseAds(raw: unknown, warn: (msg: string) => void = () => {}): AdsFile {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const s = (r.settings && typeof r.settings === 'object' ? r.settings : {}) as Record<string, unknown>;
  for (const k of Object.keys(s)) if (!KNOWN_SETTINGS.has(k)) warn(`settings.${k}: unknown setting (ignored)`);
  const num = (v: unknown, def: number, lo: number, hi: number, name: string) => {
    if (v === undefined) return def;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) { warn(`settings.${name}: ${String(v)} must be a number from ${lo} to ${hi} (using ${def})`); return def; }
    return v;
  };
  const settings: AdSettings = {
    billboardsPerKm: num(s.billboardsPerKm, DEFAULT_AD_SETTINGS.billboardsPerKm, 0, 20, 'billboardsPerKm'),
    minGapMetres: num(s.minGapMetres, DEFAULT_AD_SETTINGS.minGapMetres, 20, 2000, 'minGapMetres'),
    sameAdMinGapMetres: num(s.sameAdMinGapMetres, DEFAULT_AD_SETTINGS.sameAdMinGapMetres, 0, 20000, 'sameAdMinGapMetres'),
    ledPerRoute: num(s.ledPerRoute, DEFAULT_AD_SETTINGS.ledPerRoute, 0, 50, 'ledPerRoute'),
  };
  const ads: Ad[] = [];
  const seen = new Set<string>();
  for (const [i, a0] of (Array.isArray(r.ads) ? r.ads : []).entries()) {
    const a = (a0 && typeof a0 === 'object' ? a0 : {}) as Record<string, unknown>;
    const id = typeof a.id === 'string' && a.id.trim() ? a.id.trim() : '';
    const where = id ? `ad "${id}"` : `ads[${i}]`;
    if (!id) { warn(`${where}: needs an "id" (skipped)`); continue; }
    if (seen.has(id)) { warn(`${where}: the id is used twice (skipped)`); continue; }
    for (const k of Object.keys(a)) if (!KNOWN_AD.has(k)) warn(`${where}: unknown field "${k}" (ignored)`);
    // frequency 0..1 (old files: weight)
    const fq = a.frequency ?? a.weight;
    let frequency = 1;
    if (fq !== undefined) {
      if (typeof fq !== 'number' || !Number.isFinite(fq)) { warn(`${where}: frequency must be a number from 0 to 1 (skipped)`); continue; }
      if (fq < 0 || fq > 1) {
        if (a.frequency !== undefined) { warn(`${where}: frequency ${fq} is outside 0..1 (skipped)`); continue; }
        frequency = Math.max(0, Math.min(1, fq)); // old weight: clamped
      } else frequency = fq;
    }
    const list = (v: unknown, name: string) => {
      if (v === undefined) return ['all'];
      if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) { warn(`${where}: ${name} must be a list of names (using "all")`); return ['all']; }
      return v.length ? v as string[] : ['all'];
    };
    const date = (v: unknown, name: string) => {
      if (v === undefined) return undefined;
      if (typeof v !== 'string' || !DATE.test(v) || Number.isNaN(Date.parse(v))) { warn(`${where}: ${name} "${String(v)}" must be a date like 2026-10-01 (ignored)`); return undefined; }
      return v;
    };
    const images: Ad['images'] = {};
    const img = (v: unknown, name: string) => {
      if (typeof v !== 'string' || !IMAGE_FILE.test(v) || v.includes('..')) { warn(`${where}: ${name} "${String(v)}" is not an image file name (jpg, png or webp in client/public/assets/ads/)`); return undefined; }
      return v.replace(/^\/?(assets\/ads\/)?/, '');
    };
    if (a.images !== undefined) {
      if (typeof a.images !== 'object' || a.images === null) warn(`${where}: images must be an object of format: file`);
      else for (const [k, v] of Object.entries(a.images)) {
        if (!AD_FORMATS.includes(k as AdFormat)) { warn(`${where}: images.${k}: unknown format (wide, standard, portrait, screen)`); continue; }
        const f = img(v, `images.${k}`);
        if (f) images[k as AdFormat] = f;
      }
    }
    if (a.image !== undefined) { const f = img(a.image, 'image'); if (f) images.standard ??= f; }
    let url: string | null = null;
    if (a.url !== undefined) {
      const u = String(a.url).trim();
      if (!/^https:\/\//i.test(u)) warn(`${where}: url must start with https:// (no link)`);
      else if (!HTTPS_URL.test(u)) warn(`${where}: url "${u}" is not a valid link (no link)`);
      else url = u;
    }
    const fb = (a.fallback && typeof a.fallback === 'object' ? a.fallback : {}) as Record<string, unknown>;
    const colour = (v: unknown, def: string) => (typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v) ? v : def);
    const fallback: AdFallback = {
      bg: colour(fb.bg, '#2c3e50'), fg: colour(fb.fg, '#ffffff'),
      title: typeof fb.title === 'string' && fb.title ? fb.title : id.toUpperCase(),
      sub: typeof fb.sub === 'string' ? fb.sub : undefined,
    };
    if (!Object.keys(images).length && !a.fallback) warn(`${where}: no images and no text fallback (its name is drawn instead)`);
    seen.add(id);
    ads.push({
      id, frequency, active: a.active !== false,
      startDate: date(a.startDate, 'startDate'), endDate: date(a.endDate, 'endDate'),
      routes: list(a.routes, 'routes'), regions: list(a.regions, 'regions'), billboardTypes: list(a.billboardTypes, 'billboardTypes'),
      images, url, fallback,
    });
  }
  return { settings, ads };
}

/** Where a billboard stands, for choosing what may run on it. */
export interface AdPlace { route: string; region: string; type: BillboardType }

const fits = (list: string[], v: string) => list.includes('all') || list.includes(v);

/** May this ad run here, on this day (YYYY-MM-DD)? */
export function adRuns(ad: Ad, at: AdPlace, today: string) {
  return ad.active && ad.frequency > 0
    && (!ad.startDate || today >= ad.startDate) && (!ad.endDate || today <= ad.endDate)
    && fits(ad.routes, at.route) && fits(ad.regions, at.region) && fits(ad.billboardTypes, at.type);
}

/** A billboard to fill: where it is along the line (surveyed metres) and what kind. */
export interface AdSlot extends AdPlace { s: number; side: number; /** LED screens: how many ads rotate on it */ count?: number }

/**
 * Pick the ads for every billboard of a route, in order along the line. Each
 * pick is weighted by frequency among the ads that may run there; an ad shown
 * within sameAdMinGapMetres (either side) is left out while others can run.
 * Seeded: the same seed (a session, or a multiplayer room) gives the same ads.
 * Returns ad indices per slot (several for an LED screen; empty when no ad runs).
 */
export function pickAds(slots: AdSlot[], file: AdsFile, seed: number, today: string): number[][] {
  const rand = rng(seed >>> 0 || 1);
  const last = new Map<number, number>();
  const order = slots.map((_, i) => i).sort((a, b) => slots[a].s - slots[b].s);
  const out: number[][] = slots.map(() => []);
  for (const i of order) {
    const sl = slots[i];
    const ok = file.ads.map((a, k) => (adRuns(a, sl, today) ? k : -1)).filter(k => k >= 0);
    const want = Math.max(1, sl.count ?? 1);
    for (let n = 0; n < want && ok.length; n++) {
      const free = ok.filter(k => !out[i].includes(k) && (last.get(k) === undefined || sl.s - last.get(k)! >= file.settings.sameAdMinGapMetres));
      let k: number;
      if (free.length) {
        const total = free.reduce((a, j) => a + file.ads[j].frequency, 0);
        let x = rand() * total;
        k = free[free.length - 1];
        for (const j of free) { x -= file.ads[j].frequency; if (x < 0) { k = j; break; } }
      } else {
        // every ad was shown too recently: the one seen longest ago (a screen never repeats itself)
        const rest = ok.filter(j => !out[i].includes(j));
        if (!rest.length) break;
        k = rest.reduce((b, j) => ((last.get(j) ?? -Infinity) < (last.get(b) ?? -Infinity) ? j : b));
      }
      out[i].push(k);
      last.set(k, sl.s);
    }
  }
  return out;
}

/** Each ad's expected share of a route's billboards (frequency / sum of what can run there). */
export function expectedShares(file: AdsFile, route: string, today: string) {
  const runs = file.ads.filter(a => a.active && a.frequency > 0 && (!a.startDate || today >= a.startDate) && (!a.endDate || today <= a.endDate) && fits(a.routes, route));
  const total = runs.reduce((s, a) => s + a.frequency, 0);
  return file.ads.map(a => ({ id: a.id, frequency: a.frequency, share: runs.includes(a) && total > 0 ? a.frequency / total : 0 }));
}

/** Today as YYYY-MM-DD (local), for campaign dates. */
export function todayString(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
