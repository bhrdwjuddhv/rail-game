import * as THREE from 'three/webgpu';
import TEXTURES from '../../../data/textures.json';
import { effective, settings } from './Settings';

type Q = 'high' | 'medium' | 'low';
type Kind = 'color' | 'normal' | 'roughness';
interface SizeSet { size: [number, number]; color: string; colorKtx2?: string; normal?: string; normalKtx2?: string; roughness?: string; roughnessKtx2?: string }
export interface TexEntry {
  file: string; type: 'tile' | 'tile-x' | 'tile-y' | 'atlas' | 'sprite' | 'overlay' | 'decal';
  sizeM: [number, number]; alpha: boolean; colorSpace: 'srgb' | 'linear'; maxSize: Record<Q, number>;
  group: string; normal: number; roughness: [number, number]; rotate: boolean; triplanar?: boolean;
  alphaTest?: number; foliage?: boolean; grid?: [number, number]; materials: string[];
  processed?: { sizes: Record<string, SizeSet>; cells?: number[][] };
}
const MANIFEST = TEXTURES as unknown as { textures: Record<string, TexEntry>; budgetsMB: Record<string, number> };

/** One loaded GPU texture (a file at one size), shared by every binding that uses it. */
interface Slot { url: string; tex: THREE.Texture | null; state: 'loading' | 'queued' | 'ready' | 'failed'; bytes: number; users: number }

/** A material using a texture entry: its procedural stand-in, UV scale and current file textures. */
interface Binding {
  mat: THREE.MeshStandardMaterial; id: string; entry: TexEntry; uvMeters: [number, number];
  /** roughness before wetness (1 once a roughness map multiplies it) */
  baseRoughness: number;
  procedural: THREE.Texture; slots: Partial<Record<Kind, Slot>>; onFileLoaded?: () => void;
}

const RESIDENT_GRACE_MS = 15000;
/** diagnostics: ?textures=0 keeps every material procedural (before/after measurements) */
const FILES_OFF = new URLSearchParams(location.search).get('textures') === '0';
/** outdoor surfaces that get shinier in the rain */
const WETTABLE = new Set(['ballast', 'sleeper', 'concrete', 'platform', 'platformEdge', 'brick', 'stone', 'sheet', 'roof']);
const UPLOAD_MS = 2;
const UPLOADS_PER_FRAME = 2;

/**
 * File textures for materials, by material name (data/textures.json lists
 * which texture each material uses). The procedural texture is shown at once;
 * the processed file replaces it when it is ready, so nothing ever flashes
 * black or pink. Textures are reference counted by area: something in the
 * streaming window acquires a material, and its textures are disposed a little
 * after the last user is gone. KTX2 (Basis, transcoded in a worker) is the main
 * format, WebP the fallback. Uploads to the GPU are spread over frames.
 */
export class TextureLibrary {
  private renderer: unknown = null;
  private ktx2: Promise<{ load(url: string): Promise<THREE.Texture> }> | null = null;
  private bindings = new Map<string, Binding[]>();
  private refs = new Map<string, number>();
  private releaseTimers = new Map<string, number>();
  private slots = new Map<string, Slot>();
  private queue: { slot: Slot; tex: THREE.Texture }[] = [];
  private pendingLoads = 0;
  private loggedMissing = new Set<string>();
  private loggedBudget = false;
  /** bytes on the GPU from file textures */
  bytes = 0;

  init(renderer: unknown) { this.renderer = renderer; }

  private get quality(): Q { const q = settings.get().quality; return q === 'ultra' ? 'high' : q; }
  get budgetMB() { return MANIFEST.budgetsMB?.[this.quality] ?? 150; }
  entryFor(material: string): [string, TexEntry] | undefined {
    return Object.entries(MANIFEST.textures).find(([, e]) => e.materials.includes(material));
  }

  /** Anisotropy for grazing views (ballast, sleepers, platforms): 8 High, 4 Medium, 2 Low/mobile, capped by the GPU. */
  private anisotropy() {
    const cap = this.quality === 'high' ? 8 : this.quality === 'medium' ? 4 : 2;
    const r = this.renderer as { capabilities?: { getMaxAnisotropy?: () => number }; getMaxAnisotropy?: () => number } | null;
    const max = r?.capabilities?.getMaxAnisotropy?.() ?? r?.getMaxAnisotropy?.() ?? 8;
    return Math.max(1, Math.min(cap, max));
  }

  /**
   * Wrapping, filters and UV repeat for an entry's type. Tiles repeat both ways;
   * tile-x repeats along u and clamps along v (a wall's band stays at the bottom,
   * its top row continues above); tile-y the other way round. Real-world size:
   * one copy covers sizeM metres on geometry whose UVs are in uvMeters units.
   * Atlases, sprites and decals use their UVs as they are, clamped.
   */
  private configure(t: THREE.Texture, e: TexEntry, uvMeters: [number, number], kind: Kind) {
    applyWrap(t, e, uvMeters);
    t.colorSpace = kind === 'color' && e.colorSpace === 'srgb' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.anisotropy = this.anisotropy();
  }

  /**
   * Use the texture of `material` on `mat`. `uvMeters`: metres per UV unit on
   * the geometry (so one texture copy covers its real size, sizeM). `resident`:
   * used all along the line (track, terrain, common buildings) - acquired now
   * and never released; otherwise call acquire/release as areas stream.
   */
  bind(mat: THREE.MeshStandardMaterial, material: string, factory: () => THREE.Texture, uvMeters: number | [number, number] = 1, opts: { resident?: boolean; onFileLoaded?: () => void } = {}) {
    const found = this.entryFor(material);
    const uv: [number, number] = typeof uvMeters === 'number' ? [uvMeters, uvMeters] : uvMeters;
    const proc = factory().clone();
    proc.needsUpdate = true;
    if (found) {
      const [, e] = found;
      applyWrap(proc, e, uv);
      if (e.alphaTest) { mat.alphaTest = e.alphaTest; mat.transparent = false; mat.depthWrite = true; mat.alphaToCoverage = !!effective().antialias; }
    }
    mat.map = proc;
    if (!found) return;
    const [id, entry] = found;
    const b: Binding = { mat, id, entry, uvMeters: uv, baseRoughness: mat.roughness, procedural: proc, slots: {}, onFileLoaded: opts.onFileLoaded };
    const list = this.bindings.get(material) ?? [];
    list.push(b);
    this.bindings.set(material, list);
    if (opts.resident) this.acquire(material);
    else if ((this.refs.get(material) ?? 0) > 0) this.loadBinding(b);
  }

  /** Something in the streaming window uses this material (station, tunnel, terrain layer...). */
  acquire(material: string) {
    const n = (this.refs.get(material) ?? 0) + 1;
    this.refs.set(material, n);
    clearTimeout(this.releaseTimers.get(material));
    if (n === 1) for (const b of this.bindings.get(material) ?? []) this.loadBinding(b);
  }

  /** The last user gone: after a grace period (it may come straight back) drop the files and show the procedural texture. */
  release(material: string) {
    const n = Math.max(0, (this.refs.get(material) ?? 0) - 1);
    this.refs.set(material, n);
    if (n > 0) return;
    clearTimeout(this.releaseTimers.get(material));
    this.releaseTimers.set(material, window.setTimeout(() => {
      if ((this.refs.get(material) ?? 0) > 0) return;
      for (const b of this.bindings.get(material) ?? []) this.unloadBinding(b);
    }, RESIDENT_GRACE_MS));
  }

  /** Size to load: the preset's, or the next smaller one when the budget would be exceeded. */
  private pickSize(e: TexEntry) {
    const sizes = Object.keys(e.processed!.sizes).map(Number).sort((a, b) => b - a);
    let s = sizes.find(v => v <= e.maxSize[this.quality]) ?? sizes[sizes.length - 1];
    const est = (v: number) => v * v * 1.333 * (e.alpha ? 1 : 0.5) * (this.quality === 'low' ? 1 : 2.5);
    while (this.bytes + est(s) > this.budgetMB * 1048576 && sizes.indexOf(s) < sizes.length - 1) {
      s = sizes[sizes.indexOf(s) + 1];
      if (!this.loggedBudget) { this.loggedBudget = true; console.info(`[textures] over the ${this.budgetMB} MB budget: using smaller sizes`); }
    }
    return e.processed!.sizes[String(s)];
  }

  private loadBinding(b: Binding) {
    if (FILES_OFF) return;
    const e = b.entry;
    if (!e.processed) {
      if (!this.loggedMissing.has(b.id)) { this.loggedMissing.add(b.id); console.info(`[textures] ${b.id}: no processed file, procedural texture in use`); }
      return;
    }
    const set = this.pickSize(e);
    const kinds: Kind[] = ['color', ...(this.quality === 'low' ? [] : (['normal', 'roughness'] as Kind[]))];
    for (const kind of kinds) {
      const webp = set[kind];
      if (!webp || b.slots[kind]) continue;
      const slot = this.slot(webp, set[`${kind}Ktx2` as const], kind, e);
      slot.users++;
      b.slots[kind] = slot;
      if (slot.state === 'ready') this.apply(b, kind, slot);
    }
  }

  private unloadBinding(b: Binding) {
    for (const kind of Object.keys(b.slots) as Kind[]) {
      const slot = b.slots[kind]!;
      delete b.slots[kind];
      slot.users--;
      if (kind === 'color') b.mat.map = b.procedural;
      if (kind === 'normal') b.mat.normalMap = null;
      if (kind === 'roughness') { b.mat.roughnessMap = null; b.baseRoughness = 0.9; b.mat.roughness = 0.9 * (1 - 0.35 * this.wet); }
      b.mat.needsUpdate = true;
      if (slot.users <= 0 && slot.tex) {
        slot.tex.dispose();
        this.bytes -= slot.bytes;
        this.slots.delete(slot.url);
      }
    }
  }

  /** A file texture, loaded once and shared; KTX2 first, WebP if that fails. */
  private slot(webp: string, ktx2: string | undefined, kind: Kind, e: TexEntry) {
    const key = ktx2 ?? webp;
    let s = this.slots.get(key);
    if (s) return s;
    s = { url: key, tex: null, state: 'loading', bytes: 0, users: 0 };
    this.slots.set(key, s);
    const base = `${import.meta.env.BASE_URL}assets/`;
    const slot = s;
    this.pendingLoads++;
    const done = (tex: THREE.Texture) => {
      this.configure(tex, e, [1, 1], kind);
      slot.tex = tex;
      slot.state = 'queued';
      this.queue.push({ slot, tex });
    };
    (ktx2 ? this.loadKtx2(base + ktx2) : Promise.reject(new Error('no ktx2')))
      .catch(() => new THREE.TextureLoader().loadAsync(base + webp))
      .then(done)
      .catch(err => { slot.state = 'failed'; console.warn(`[textures] ${webp} failed - procedural texture stays`, err); })
      .finally(() => { this.pendingLoads--; });
    return s;
  }

  private loadKtx2(url: string) {
    this.ktx2 ??= import('three/addons/loaders/KTX2Loader.js').then(({ KTX2Loader }) => {
      const l = new KTX2Loader().setTranscoderPath(`${import.meta.env.BASE_URL}basis/`).setWorkerLimit(2);
      if (this.renderer) l.detectSupport(this.renderer as never);
      return { load: (u: string) => l.loadAsync(u) as Promise<THREE.Texture> };
    });
    return this.ktx2.then(k => k.load(url));
  }

  private apply(b: Binding, kind: Kind, slot: Slot) {
    const t = slot.tex!.clone(); // same GPU data, own UV repeat
    this.configure(t, b.entry, b.uvMeters, kind);
    t.needsUpdate = false;
    const m = b.mat;
    if (kind === 'color') { m.map = t; b.onFileLoaded?.(); }
    if (kind === 'normal') { m.normalMap = t; m.normalScale.set(0.9, 0.9); }
    if (kind === 'roughness') { m.roughnessMap = t; b.baseRoughness = 1; m.roughness = 1 - 0.35 * this.wet; }
    m.needsUpdate = true;
  }

  private bytesOf(t: THREE.Texture) {
    const mips = (t as THREE.CompressedTexture).mipmaps as { data?: ArrayBufferView }[] | undefined;
    if ((t as THREE.CompressedTexture).isCompressedTexture && mips?.length) return mips.reduce((a, m) => a + (m.data?.byteLength ?? 0), 0);
    const img = t.image as { width?: number; height?: number } | undefined;
    return (img?.width ?? 0) * (img?.height ?? 0) * 4 * 1.333;
  }

  /**
   * Upload queued textures to the GPU: at most 2 per frame or ~2 ms, so
   * streaming never causes a hitch. `all`: no limit (loading screen).
   */
  update(all = false) {
    const r = this.renderer as { initTexture?: (t: THREE.Texture) => void } | null;
    const t0 = performance.now();
    let n = 0;
    while (this.queue.length && (all || (n < UPLOADS_PER_FRAME && performance.now() - t0 < UPLOAD_MS))) {
      const { slot, tex } = this.queue.shift()!;
      r?.initTexture?.(tex);
      slot.bytes = this.bytesOf(tex);
      this.bytes += slot.bytes;
      slot.state = 'ready';
      for (const [material, list] of this.bindings) {
        if ((this.refs.get(material) ?? 0) === 0) continue;
        for (const b of list) for (const kind of Object.keys(b.slots) as Kind[]) if (b.slots[kind] === slot) this.apply(b, kind, slot);
      }
      n++;
    }
  }

  /** Loading screen: wait for every requested texture and upload them all. */
  async settle(timeoutMs = 20000) {
    const t0 = performance.now();
    while ((this.pendingLoads > 0 || this.queue.length) && performance.now() - t0 < timeoutMs) {
      this.update(true);
      await new Promise(r => setTimeout(r, 30));
    }
    this.update(true);
  }

  private wet = 0;
  /**
   * Rain darkens and sheens outdoor surfaces: roughness drops up to 35 % with
   * wetness (a material uniform, no new textures). Changes are smoothed and
   * only written when they move.
   */
  setWetness(rain: number) {
    const w = Math.round(Math.min(1, rain) * 20) / 20;
    if (w === this.wet) return;
    this.wet = w;
    for (const [material, list] of this.bindings) {
      if (!WETTABLE.has(material) && !material.startsWith('terrain:')) continue;
      for (const b of list) b.mat.roughness = b.baseRoughness * (1 - 0.35 * w);
    }
  }

  stats() {
    return { mb: this.bytes / 1048576, count: [...this.slots.values()].filter(s => s.state === 'ready').length, queued: this.queue.length, loading: this.pendingLoads, budgetMB: this.budgetMB };
  }

  /**
   * The colour texture of a material, loaded but not bound or uploaded (for
   * textures assembled into arrays, like the terrain layers). KTX2 first, WebP
   * if that fails; null when there is no processed file or both fail.
   */
  async loadRaw(material: string): Promise<{ tex: THREE.Texture; entry: TexEntry } | null> {
    if (FILES_OFF) return null;
    const found = this.entryFor(material);
    if (!found?.[1].processed) return null;
    const entry = found[1];
    const set = this.pickSize(entry);
    const base = `${import.meta.env.BASE_URL}assets/`;
    this.pendingLoads++;
    try {
      const tex = await (set.colorKtx2 ? this.loadKtx2(base + set.colorKtx2) : Promise.reject(new Error('no ktx2')))
        .catch(() => new THREE.TextureLoader().loadAsync(base + set.color));
      return { tex, entry };
    } catch (e) {
      console.warn(`[textures] ${material}: ${set.color} failed`, e);
      return null;
    } finally { this.pendingLoads--; }
  }

  /** Every manifest entry with where its texture comes from (Texture Test, F3). */
  report() {
    return Object.entries(MANIFEST.textures).map(([id, e]) => {
      const set = e.processed ? this.pickSize(e) : null;
      const slot = set ? this.slots.get(set.colorKtx2 ?? set.color) : undefined;
      return {
        id, type: e.type, materials: e.materials,
        source: FILES_OFF ? 'procedural (files off)' : !e.processed ? 'procedural (no file)' : slot?.state === 'ready' ? (slot.url.endsWith('.ktx2') ? 'file (KTX2)' : 'file (WebP)') : slot?.state === 'failed' ? 'procedural (load failed)' : 'file (not loaded here)',
        size: set ? `${set.size[0]}x${set.size[1]}` : '-',
      };
    });
  }

  /**
   * Load one entry's colour / normal / roughness (Texture Test scene): configured
   * for real-world size on geometry with UVs in `uvMeters` units. Not shared,
   * not budgeted - the caller disposes them.
   */
  async loadSet(id: string, uvMeters: [number, number]) {
    const e = MANIFEST.textures[id];
    if (!e?.processed || FILES_OFF) return null;
    const set = this.pickSize(e);
    const base = `${import.meta.env.BASE_URL}assets/`;
    const one = async (kind: Kind) => {
      const webp = set[kind];
      if (!webp) return null;
      const ktx = set[`${kind}Ktx2` as const];
      const t = await (ktx ? this.loadKtx2(base + ktx) : Promise.reject(new Error('no ktx2'))).catch(() => new THREE.TextureLoader().loadAsync(base + webp)).catch(() => null);
      if (t) this.configure(t, e, uvMeters, kind);
      return t;
    };
    const [color, normal, roughness] = await Promise.all([one('color'), one('normal'), one('roughness')]);
    return color ? { color, normal, roughness, entry: e } : null;
  }

  /** GPU memory of textures built outside the library (e.g. the terrain array). */
  account(bytes: number) { this.bytes += bytes; }
  /** Upload now (loading screen) instead of on the first frame that draws it. */
  upload(t: THREE.Texture) { (this.renderer as { initTexture?: (t: THREE.Texture) => void } | null)?.initTexture?.(t); }

  /** UV rects of an atlas texture's cells (half-texel inset, from the manifest) or null. */
  cells(material: string) { return this.entryFor(material)?.[1].processed?.cells ?? null; }
}

/** Wrap modes and real-world UV scale for an entry's type (see configure). */
function applyWrap(t: THREE.Texture, e: TexEntry, uvMeters: [number, number]) {
  const tiled = e.type === 'tile' || e.type === 'tile-x' || e.type === 'tile-y';
  const repX = e.type === 'tile' || e.type === 'tile-x', repY = e.type === 'tile' || e.type === 'tile-y';
  t.wrapS = repX ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.wrapT = repY ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.repeat.set(tiled ? uvMeters[0] / e.sizeM[0] : 1, tiled ? uvMeters[1] / e.sizeM[1] : 1);
}

export const textures = new TextureLibrary();
