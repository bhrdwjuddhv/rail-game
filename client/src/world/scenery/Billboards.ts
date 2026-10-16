import * as THREE from 'three/webgpu';
import ADS_RAW from '../../../../data/ads.json';
import ADS_MOCK from '../../../../data/ads.mock.json';
import { houseAdList, houseArt } from './HouseAds';
import { biomeOf } from '@rail/shared/track/Route';
import adsUrl from '../../../../data/ads.json?url';
import { Ad, AdFormat, AdSlot, AdsFile, adRuns, advertiseHere, BillboardType, FORMAT_ASPECT, parseAds, pickAds, todayString } from '@rail/shared/ads/Ads';
import type { Railway } from '@rail/shared/track/Railway';
import { bus } from '@rail/shared/events';
import { GeoBatch, mat } from '../../core/GeoBatch';
import { canvasTexture } from '../../core/Textures';
import { materials } from '../../core/Materials';
import type { TerrainField } from '../TerrainField';
import { BillboardSlot, planBillboards, PlanStats, SPEC } from './BillboardSlots';

/**
 * Billboards along the line, showing the ads in data/ads.json.
 *
 * Where: planned once per route (BillboardSlots: neat slots along the line,
 * checked to be in sight from the cab, kept clear of trees and buildings).
 * What: each slot's ad picked per session by frequency (seeded: the same seed
 * gives the same ads). How: ten kinds of structure, instanced per kind, the ad
 * panels grouped by ad (one material per ad and format); LED screens rotate
 * their ads every 8 s and glow; lit hoardings are floodlit at night, except
 * near signals. Built per kilometre of line as the camera comes near.
 *
 * Clicking a billboard (a click or tap, not a drag) hands its ad to onClick
 * (the game pauses and shows a card: only its "Visit website" opens the link).
 */

const DIST_CLICK = 300;
const LED_PERIOD = 8;

interface Part { geo: THREE.BufferGeometry; key: string }
interface Kind { parts: Part[]; lamps: THREE.BufferGeometry | null; panels: THREE.Matrix4[]; lit: boolean }
interface Built { group: THREE.Group; panels: THREE.InstancedMesh[]; leds: { mesh: THREE.Mesh; ads: number[]; slot: BillboardSlot }[] }
export interface ClickedAd { ad: Ad; image: string | null; slot: BillboardSlot }

const STYLE_TINT: Record<BillboardSlot['style'], [number, number, number]> = { clean: [1, 1, 1], rusty: [1.0, 0.72, 0.55], weathered: [0.82, 0.82, 0.78] };

export class Billboards {
  readonly group = new THREE.Group();
  file: AdsFile;
  readonly slots: BillboardSlot[];
  readonly dropped: BillboardSlot[];
  readonly stats: PlanStats;
  private picks: number[][] = [];
  private kinds = new Map<string, Kind>();
  private mats = new Map<string, THREE.MeshStandardMaterial>();
  private texs = new Map<string, THREE.Texture>();
  private built = new Map<number, Built>();
  private ledMats: THREE.MeshStandardMaterial[] = [];
  private ledT = 0;
  private night = 0;
  private raycaster = new THREE.Raycaster();
  private down: { x: number; y: number; t: number } | null = null;
  private hoverAt = 0;
  private markers: THREE.Group | null = null;
  private readonly today = todayString();
  onClick: ((c: ClickedAd) => void) | null = null;
  /** God Mode "Show sample ads": the fictional campaigns in data/ads.mock.json run too (off by default) */
  static sampleAds = false;
  /** how many ads came from the files (the house designs follow them in file.ads) */
  private real = 0;
  /** billboards showing a real ad / the "advertise here" board / filler art */
  houseCounts = { real: 0, advertise: 0, filler: 0 };

  constructor(private dom: HTMLElement, private camera: () => THREE.Camera, private railway: Railway, field: TerrainField, private seed: number, private small: boolean) {
    this.group.name = 'billboards';
    this.file = this.load(ADS_RAW);
    const plan = planBillboards(railway, field, this.file.settings);
    this.slots = plan.slots; this.dropped = plan.dropped; this.stats = plan.stats;
    this.pick();
    dom.addEventListener('pointerdown', this.onDown);
    dom.addEventListener('pointerup', this.onUp);
    dom.addEventListener('pointermove', this.onMove);
  }

  /** Clear zones (BillboardSlots) for the scenery: nothing tall in them. */
  get zones() { return this.slots.map(s => s.zone).filter(z => z.length >= 6); }
  /** km buckets (surveyed) that have billboards: Game streams one group per bucket */
  get buckets() { return [...new Set(this.slots.map(s => Math.floor(s.s / 1000)))]; }

  /** The ads file (and the sample campaigns when switched on), then the house designs after its ads. */
  private load(raw: unknown) {
    const r = raw as { ads?: unknown[] };
    const f = parseAds(Billboards.sampleAds ? { ...r, ads: [...(r.ads ?? []), ...ADS_MOCK.ads] } : raw, m => console.warn(`[ads] ${m}`));
    this.real = f.ads.length;
    f.ads.push(...houseAdList(f.house));
    return f;
  }

  private pick() {
    const at: AdSlot[] = this.slots.map(s => ({ s: s.s, side: s.side, route: this.railway.main.data.id, region: s.region, type: s.type, count: s.type === 'led' ? 3 : 1 }));
    this.picks = pickAds(at, this.file, this.seed, this.today);
    // billboards no ad took: "advertise here" on the best spots (LED screens, station approaches, big hoardings), filler art elsewhere
    const h = this.file.house, idx = (id: string) => this.file.ads.findIndex(a => a.id === id);
    const stations = this.railway.main.stations.filter(st => st.type !== 'halt').map(st => st.km * 1000);
    const free = this.slots.map((s, i) => ({ i, s: s.s, score: (s.type === 'led' ? 4 : 0) + (stations.some(k => Math.abs(k - s.s) < 1500) ? 2 : 0) + (s.type === 'wide' || s.type === 'unipole' || s.type === 'rooftop' ? 1 : 0) }))
      .filter(e => !this.picks[e.i].length);
    const adv = h.fillerEnabled ? advertiseHere(free, h.advertiseHereShare) : new Set(free.map(e => e.i));
    this.houseCounts = { real: this.slots.length - free.length, advertise: adv.size, filler: free.length - adv.size };
    for (const e of free) {
      const sl = this.slots[e.i];
      if (adv.has(e.i)) { this.picks[e.i] = [idx('_advertise-here')]; continue; }
      const reg = this.railway.main.regions[sl.region], b = reg ? biomeOf(reg) : 'plains';
      const art = b === 'snow' ? 'snow' : b === 'ghats' ? 'ghats' : b === 'desert' || b === 'hills' ? 'desert' : b === 'coast' ? 'coast' : 'plains';
      const scenic = idx(`_scenic-${art}`), safety = idx(`_safety-${sl.id % 4}`);
      this.picks[e.i] = sl.type === 'led' ? [scenic, safety] : (sl.id * 7919) % 100 < 45 ? [safety] : [scenic];
    }
  }

  // ------------------------------------------------------------------ building

  /** The billboards of one kilometre of line (surveyed km bucket). */
  build(bucket: number): THREE.Group {
    const group = new THREE.Group();
    group.name = `billboards-${bucket}`;
    this.fill(bucket, group);
    this.group.add(group);
    return group;
  }

  release(bucket: number) {
    const b = this.built.get(bucket);
    if (!b) return;
    b.group.removeFromParent();
    this.clear(b);
    this.built.delete(bucket);
  }

  private clear(b: Built) {
    for (const o of [...b.group.children]) {
      o.removeFromParent();
      if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
    }
    for (const l of b.leds) this.ledMats.splice(this.ledMats.indexOf(l.mesh.material as THREE.MeshStandardMaterial), 1);
  }

  private fill(bucket: number, group: THREE.Group) {
    const list = this.slots.map((s, i) => ({ s, i })).filter(({ s }) => Math.floor(s.s / 1000) === bucket);
    const built: Built = { group, panels: [], leds: [] };
    const M = materials() as unknown as Record<string, THREE.Material>;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
    // structures: instanced per kind and part; lamps only where lit
    const byKind = new Map<string, { s: BillboardSlot; m: THREE.Matrix4 }[]>();
    // panels: instanced per material (ad, format, lit/dark)
    const byMat = new Map<string, { m: THREE.Matrix4[]; who: { slot: BillboardSlot; ad: number }[] }>();
    for (const { s, i } of list) {
      // a V-shaped hoarding's second face is turned by ry2 - ry: one structure per way round
      const key = s.type === 'vshape' ? `vshape${Math.sign(wrap((s.ry2 ?? s.ry) - s.ry)) || 1}` : s.type;
      const kind = this.kind(key);
      p.set(s.x, s.y, s.z); q.setFromAxisAngle(up, s.ry); m.compose(p, q, one);
      (byKind.get(key) ?? byKind.set(key, []).get(key)!).push({ s, m: m.clone() });
      const ads = this.picks[i];
      if (!ads.length) continue;
      if (s.type === 'led') {
        // its own screen: the ads rotate on it
        const mat = new THREE.MeshStandardMaterial({ map: this.texture(ads[0], 'screen'), emissive: new THREE.Color(0xffffff), emissiveMap: this.texture(ads[0], 'screen'), emissiveIntensity: 0.55, roughness: 0.3 });
        const mesh = new THREE.Mesh(PANEL, mat);
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(m).multiply(kind.panels[0]);
        mesh.userData.led = built.leds.length;
        group.add(mesh);
        built.leds.push({ mesh, ads, slot: s });
        this.ledMats.push(mat);
        continue;
      }
      const lit = kind.lit && !s.dim;
      for (const pm of kind.panels) {
        const ad = ads[0];
        const k = `${ad}|${s.format}|${lit ? 1 : 0}`;
        const e = byMat.get(k) ?? byMat.set(k, { m: [], who: [] }).get(k)!;
        e.m.push(m.clone().multiply(pm));
        e.who.push({ slot: s, ad });
      }
    }
    for (const [key, items] of byKind) {
      const kind = this.kind(key);
      for (const part of kind.parts) {
        const im = new THREE.InstancedMesh(part.geo, M[part.key] ?? M.std, items.length);
        items.forEach(({ s, m: mm }, i) => {
          im.setMatrixAt(i, mm);
          const t = STYLE_TINT[s.style];
          if (part.key === 'metal') im.setColorAt(i, new THREE.Color(t[0], t[1], t[2]));
        });
        im.castShadow = im.receiveShadow = true;
        im.computeBoundingSphere();
        group.add(im);
      }
      const lit = items.filter(x => !x.s.dim);
      if (kind.lamps && lit.length) {
        const im = new THREE.InstancedMesh(kind.lamps, M.lamp, lit.length);
        lit.forEach(({ m: mm }, i) => im.setMatrixAt(i, mm));
        im.computeBoundingSphere();
        group.add(im);
      }
    }
    for (const [k, e] of byMat) {
      const im = new THREE.InstancedMesh(PANEL, this.material(k), e.m.length);
      e.m.forEach((mm, i) => im.setMatrixAt(i, mm));
      im.userData.who = e.who;
      im.receiveShadow = true;
      im.computeBoundingSphere();
      group.add(im);
      built.panels.push(im);
    }
    this.built.set(bucket, built);
  }

  /** Structure of a kind of billboard (local: base at y 0, the face toward +z). */
  private kind(key: string): Kind {
    let k = this.kinds.get(key);
    if (k) return k;
    const type = (key.startsWith('vshape') ? 'vshape' : key) as BillboardType;
    const side = key === 'vshape-1' ? -1 : 1;
    const sp = SPEC[type], b = new GeoBatch(), lamps = new GeoBatch();
    const panels: THREE.Matrix4[] = [];
    const W = sp.w, Hh = sp.h, B = sp.bottom, top = B + Hh;
    const panelAt = (x: number, y: number, z: number, ry = 0) => panels.push(mat(x, y + Hh / 2, z, ry).multiply(new THREE.Matrix4().makeScale(W, Hh, 1)));
    /** a framed panel: back sheet and a light frame round the face */
    const framed = (x: number, z: number, ry = 0, colour = '#e9e9e4') => {
      const o = mat(x, 0, z, ry);
      b.box(W + 0.3, Hh + 0.3, 0.12, o.clone().multiply(mat(0, B + Hh / 2, -0.1)), '#3c4044', 'metal');
      for (const [w, h, fx, fy] of [[W + 0.3, 0.14, 0, B - 0.07], [W + 0.3, 0.14, 0, top + 0.07], [0.14, Hh + 0.3, -W / 2 - 0.07, B + Hh / 2], [0.14, Hh + 0.3, W / 2 + 0.07, B + Hh / 2]] as const)
        b.box(w, h, 0.16, o.clone().multiply(mat(fx, fy, 0.02)), colour, 'metal');
      panelAt(x, B, z + 0.06, ry);
    };
    const lampsAbove = (xs: number[], x0 = 0, z0 = 0, ry = 0) => {
      const o = mat(x0, 0, z0, ry);
      for (const x of xs) {
        b.box(0.06, 0.06, 1.1, o.clone().multiply(mat(x, top + 0.25, 0.5)), '#3c4044', 'metal');
        lamps.box(0.45, 0.1, 0.2, o.clone().multiply(mat(x, top + 0.2, 1.05)), '#fff3c4', 'lamp');
      }
    };
    const leg = (x: number, z: number, h: number, w = 0.3) => b.box(w, h + LEG_DEPTH, w, mat(x, (h - LEG_DEPTH) / 2, z), '#5c6166', 'metal');
    let lit = true;
    switch (type) {
      case 'classic': case 'led': {
        for (const x of [-1.9, 1.9]) leg(x, -0.35, top);
        for (const y of [1.6, 3.4]) b.box(3.8, 0.12, 0.12, mat(0, y, -0.35, 0, 0, y < 2 ? 0.45 : -0.45), '#5c6166', 'metal');
        b.box(W + 0.4, 0.08, 0.9, mat(0, B - 0.55, 0.45), '#4a4f53', 'metal');
        b.box(W + 0.4, 0.05, 0.05, mat(0, B + 0.45, 0.88), '#c9cdd1', 'metal');
        if (type === 'led') {
          // a dark bezel round the screen, a cabinet behind
          b.box(W + 0.5, Hh + 0.5, 0.5, mat(0, B + Hh / 2, -0.28), '#151719', 'metal');
          panelAt(0, B, 0.02);
          lit = false;
        } else { framed(0, 0); lampsAbove([-1.6, 1.6]); }
        break;
      }
      case 'wide': {
        for (const x of [-4.2, 0, 4.2]) leg(x, -0.4, top);
        for (const x of [-2.1, 2.1]) b.box(4.2, 0.12, 0.12, mat(x, 2.6, -0.4, 0, 0, x < 0 ? 0.5 : -0.5), '#5c6166', 'metal');
        b.box(W + 0.4, 0.08, 1.0, mat(0, B - 0.6, 0.5), '#4a4f53', 'metal'); // catwalk
        b.box(W + 0.4, 0.05, 0.05, mat(0, B + 0.4, 0.98), '#c9cdd1', 'metal');
        framed(0, 0); lampsAbove([-4.5, -1.5, 1.5, 4.5]);
        break;
      }
      case 'vshape': {
        // two panels meeting at a post (the apex), the second turned the other way (ry2: built per face)
        leg(0, 0, top, 0.35);
        for (const x of [W - 0.4]) leg(x, -0.3, top);
        framed(W / 2, 0); lampsAbove([W / 2 - 1.6, W / 2 + 1.6]);
        // the second face's frame is placed by its own instance yaw (ry2); its structure mirrored here
        const d = side * 2 * (SPEC.vshape.angle * Math.PI / 180);
        const o = mat(0, 0, 0, d);
        b.box(0.3, top + LEG_DEPTH, 0.3, o.clone().multiply(mat(-(W - 0.4), (top - LEG_DEPTH) / 2, -0.3)), '#5c6166', 'metal');
        b.box(W + 0.3, Hh + 0.3, 0.12, o.clone().multiply(mat(-W / 2, B + Hh / 2, -0.1)), '#3c4044', 'metal');
        // (its panel, turned with it)
        panels.push(o.clone().multiply(mat(-W / 2, B + Hh / 2, 0.06)).multiply(new THREE.Matrix4().makeScale(W, Hh, 1)));
        break;
      }
      case 'unipole': {
        b.cyl(0.45, 0.6, B + LEG_DEPTH, 12, mat(0, (B - LEG_DEPTH) / 2, -0.6), '#6d7378', 'metal');
        b.box(W * 0.6, 0.4, 0.4, mat(0, B - 0.2, -0.6), '#5c6166', 'metal');
        b.box(W + 0.4, 0.08, 1.0, mat(0, B - 0.55, 0.45), '#4a4f53', 'metal');
        framed(0, 0); lampsAbove([-3.5, 0, 3.5]);
        break;
      }
      case 'rooftop': {
        // a 3-storey building with the hoarding on its roof
        b.box(10, 9.5 + LEG_DEPTH, 6.5, mat(0, (9.5 - LEG_DEPTH) / 2, -1.5), '#d9cfbf', 'facade');
        b.box(10.4, 0.4, 6.9, mat(0, 9.7, -1.5), '#b9ad9b', 'concrete');
        for (const x of [-3, 3]) b.box(0.25, top - 9.9, 0.25, mat(x, (top + 9.9) / 2, -0.3), '#5c6166', 'metal');
        framed(0, 0); lampsAbove([-2.5, 2.5]);
        break;
      }
      case 'wall': {
        // a compound wall with the ad painted on it
        b.box(W + 0.6, Hh + 0.9 + LEG_DEPTH, 0.35, mat(0, (Hh + 0.9 - LEG_DEPTH) / 2, -0.18), '#d8cdb8', 'brick');
        b.box(W + 0.8, 0.12, 0.45, mat(0, Hh + 0.96, -0.18), '#b8ad98', 'concrete');
        panelAt(0, B, 0.005);
        lit = false;
        break;
      }
      case 'kiosk': {
        b.cyl(0.07, 0.08, B + LEG_DEPTH, 8, mat(0, (B - LEG_DEPTH) / 2, -0.12), '#7b8288', 'metal');
        b.box(W + 0.16, Hh + 0.16, 0.18, mat(0, B + Hh / 2, -0.06), '#e2e4e6', 'metal');
        panelAt(0, B, 0.04);
        lit = false;
        break;
      }
      case 'platform': {
        for (const x of [-1.3, 1.3]) b.box(0.08, top, 0.08, mat(x, top / 2, -0.08), '#56606a', 'metal');
        framed(0, 0, 0, '#56606a');
        lit = true;
        break;
      }
      case 'fob': {
        panelAt(0, B, 0.02);
        b.box(W + 0.2, Hh + 0.2, 0.05, mat(0, B + Hh / 2, -0.02), '#59636b', 'metal');
        lit = false;
        break;
      }
    }
    const parts: Part[] = [];
    for (const key2 of ['metal', 'brick', 'concrete', 'facade']) { const g = b.geometry(key2); if (g) parts.push({ geo: g, key: key2 }); }
    k = { parts, lamps: lamps.geometry('lamp'), panels, lit };
    this.kinds.set(key, k);
    return k;
  }

  // ------------------------------------------------------------------ ads: textures and materials

  private material(key: string) {
    let m = this.mats.get(key);
    if (m) return m;
    const [ad, format, lit] = key.split('|');
    const t = this.texture(Number(ad), format as AdFormat);
    m = new THREE.MeshStandardMaterial({ map: t, roughness: 0.55, emissive: new THREE.Color(0xffffff), emissiveMap: t, emissiveIntensity: 0 });
    m.userData.lit = lit === '1';
    m.emissiveIntensity = m.userData.lit ? this.night * 0.55 : 0;
    this.mats.set(key, m);
    return m;
  }

  /** An ad in a format: its image for that format, else another of its images cropped to fit, else its text. */
  private texture(i: number, format: AdFormat) {
    const key = `${i}|${format}`;
    let t = this.texs.get(key);
    if (t) return t;
    const ad = this.file.ads[i];
    const aspect = FORMAT_ASPECT[format];
    const fb = ad.house ? houseArt(ad, format) : drawnAd(ad, format);
    t = fb.clone();
    t.needsUpdate = true;
    this.texs.set(key, t);
    const file = ad.images[format] ?? ad.images.standard ?? ad.images.wide ?? ad.images.screen ?? ad.images.portrait;
    if (file) {
      const tex = t;
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        if (img.naturalWidth > 4096 || img.naturalHeight > 4096) console.warn(`[ads] ${ad.id}: ${file} is ${img.naturalWidth}x${img.naturalHeight}: larger than needed (see ADS_GUIDE.md for sizes)`);
        // centre crop to the format; phones get half size
        const ia = img.naturalWidth / img.naturalHeight;
        const sw = ia > aspect ? img.naturalHeight * aspect : img.naturalWidth, sh = ia > aspect ? img.naturalHeight : img.naturalWidth / aspect;
        const scale = Math.min(1, (this.small ? 512 : 1024) / Math.max(sw, sh));
        const c = document.createElement('canvas');
        c.width = Math.max(2, Math.round(sw * scale)); c.height = Math.max(2, Math.round(sh * scale));
        c.getContext('2d')!.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, 0, 0, c.width, c.height);
        // a new size: the GPU copy (fixed-size storage, made for the text ad) is dropped and made again
        tex.dispose();
        tex.image = c;
        tex.needsUpdate = true;
      };
      img.onerror = () => console.warn(`[ads] ${ad.id}: image ${file} not found in assets/ads/ - showing the text ad`);
      img.src = `${import.meta.env.BASE_URL}assets/ads/${file}`;
    }
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }

  // ------------------------------------------------------------------ per frame

  /** night 0..1: floodlit faces at night (not near signals); LED screens change ad every 8 s. */
  update(dt: number, night: number) {
    if (Math.abs(night - this.night) > 0.01) {
      this.night = night;
      for (const m of this.mats.values()) m.emissiveIntensity = m.userData.lit ? night * 0.55 : 0;
    }
    for (const m of this.ledMats) m.emissiveIntensity = 0.45 + night * 0.5;
    this.ledT += dt;
    if (this.ledT < LED_PERIOD) return;
    this.ledT = 0;
    for (const b of this.built.values()) for (const l of b.leds) {
      const n = l.mesh.userData.n = ((l.mesh.userData.n ?? 0) + 1) % l.ads.length;
      const mat = l.mesh.material as THREE.MeshStandardMaterial, t = this.texture(l.ads[n], 'screen');
      mat.map = t; mat.emissiveMap = t; // same maps in use: no shader change
    }
  }

  // ------------------------------------------------------------------ debug (God Mode)

  /**
   * Each ad: frequency, its expected share of this route's billboards and how many it got. The
   * expectation goes billboard by billboard: frequency / sum of the ads that may run on that one
   * (type, region, dates), so an ad limited to a few kinds of billboard expects only its part.
   */
  report() {
    const route = this.railway.main.data.id;
    const exp = this.file.ads.map(() => 0);
    for (const sl of this.slots) {
      const at = { route, region: sl.region, type: sl.type };
      const ok = this.file.ads.map((a, i) => (adRuns(a, at, this.today) ? i : -1)).filter(i => i >= 0);
      const sum = Math.max(1, ok.reduce((t, i) => t + this.file.ads[i].frequency, 0));
      for (const i of ok) exp[i] += this.file.ads[i].frequency / sum;
    }
    const total = this.slots.length || 1;
    return this.file.ads.slice(0, this.real).map((a, i) => ({ id: a.id, frequency: a.frequency, share: exp[i] / total, expected: Math.round(exp[i]), count: this.picks.filter(p => p[0] === i).length }));
  }

  /** Reload the ads file (no restart): new picks, built billboards refilled. */
  async reload() {
    try {
      const raw = await (await fetch(`${adsUrl}${adsUrl.includes('?') ? '&' : '?'}t=${Date.now()}`)).json();
      this.file = this.load(raw);
    } catch (e) { console.warn('[ads] could not reload the ads file', e); return false; }
    for (const t of this.texs.values()) t.dispose();
    this.texs.clear(); this.mats.clear();
    this.pick();
    for (const [bucket, b] of this.built) { this.clear(b); this.fill(bucket, b.group); }
    return true;
  }

  /** Markers over every slot: green ok, yellow moved, red dropped (God Mode "Show blocked billboards"). */
  showMarkers(on: boolean) {
    if (!on) { this.markers?.removeFromParent(); this.markers = null; return; }
    if (this.markers) return;
    const g = new THREE.Group();
    const geo = new THREE.CylinderGeometry(0.6, 0.6, 30, 6).translate(0, 15, 0);
    for (const [status, colour] of [['ok', 0x3ad16b], ['moved', 0xffc83a], ['dropped', 0xff4a3a]] as const) {
      const list = [...this.slots, ...this.dropped].filter(s => s.status === status);
      if (!list.length) continue;
      const im = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.6, depthWrite: false }), list.length);
      list.forEach((s, i) => im.setMatrixAt(i, new THREE.Matrix4().makeTranslation(s.x, s.y, s.z)));
      im.frustumCulled = false;
      g.add(im);
    }
    this.markers = g;
    this.group.add(g);
  }

  // ------------------------------------------------------------------ clicks

  private hit(e: PointerEvent): ClickedAd | null {
    const r = this.dom.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera());
    this.raycaster.far = DIST_CLICK;
    const targets: THREE.Object3D[] = [];
    for (const b of this.built.values()) { targets.push(...b.panels); for (const l of b.leds) targets.push(l.mesh); }
    const h = this.raycaster.intersectObjects(targets, false)[0];
    if (!h) return null;
    let slot: BillboardSlot, ad: number;
    if (h.object.userData.led !== undefined) {
      const l = [...this.built.values()].flatMap(b => b.leds).find(x => x.mesh === h.object)!;
      slot = l.slot; ad = l.ads[(l.mesh.userData.n ?? 0) % l.ads.length];
    } else {
      const w = (h.object.userData.who as { slot: BillboardSlot; ad: number }[])[h.instanceId ?? 0];
      slot = w.slot; ad = w.ad;
    }
    const a = this.file.ads[ad];
    // filler art is just scenery; the "advertise here" board opens its card
    if (a.house && a.house !== 'advertise') return null;
    const img = a.images[slot.format] ?? a.images.standard ?? a.images.wide ?? a.images.screen ?? a.images.portrait;
    return { ad: a, image: img ? `${import.meta.env.BASE_URL}assets/ads/${img}` : null, slot };
  }
  private onDown = (e: PointerEvent) => { this.down = { x: e.clientX, y: e.clientY, t: performance.now() }; };
  private onUp = (e: PointerEvent) => {
    const d = this.down; this.down = null;
    // a click or tap, not a look-around drag
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8 || performance.now() - d.t > 500) return;
    const c = this.hit(e);
    if (!c) return;
    bus.emit('billboard:clicked', { adId: c.ad.id, slot: c.slot.id });
    this.onClick?.(c);
  };
  private onMove = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse' || e.buttons) return;
    const now = performance.now();
    if (now - this.hoverAt < 120) return;
    this.hoverAt = now;
    this.dom.style.cursor = this.hit(e) ? 'pointer' : '';
  };

  dispose() {
    this.dom.removeEventListener('pointerdown', this.onDown);
    this.dom.removeEventListener('pointerup', this.onUp);
    this.dom.removeEventListener('pointermove', this.onMove);
    for (const k of [...this.built.keys()]) this.release(k);
  }
}

/** legs and walls reach this far below the base (they stand on the highest ground: on a slope they go down to the lowest) */
const LEG_DEPTH = 3.4;
/** the unit ad panel (scaled per billboard), facing +z */
const PANEL = new THREE.PlaneGeometry(1, 1);

/** an angle in (-pi, pi] */
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** A text ad drawn for a format (ads without an image, and while an image loads). */
function drawnAd(a: Ad, format: AdFormat) {
  const f = a.fallback;
  const aspect = FORMAT_ASPECT[format];
  const W = aspect >= 1 ? 768 : 384, H = Math.round(W / aspect);
  return canvasTexture(`ad-${a.id}-${format}-${f.bg}-${f.fg}-${f.title}-${f.sub ?? ''}`, W, H, g => {
    g.fillStyle = f.bg; g.fillRect(0, 0, W, H);
    g.fillStyle = f.fg; g.textAlign = 'center'; g.textBaseline = 'middle';
    const fit = (text: string, size: number, bold: boolean, maxW: number) => {
      let s = size;
      g.font = `${bold ? 'bold ' : ''}${s}px Arial`;
      while (g.measureText(text).width > maxW && s > 12) { s -= 2; g.font = `${bold ? 'bold ' : ''}${s}px Arial`; }
    };
    if (aspect >= 1) {
      fit(f.title, Math.round(H * 0.3), true, W * 0.9);
      g.fillText(f.title, W / 2, f.sub ? H * 0.4 : H / 2);
      if (f.sub) { fit(f.sub, Math.round(H * 0.15), false, W * 0.9); g.fillText(f.sub, W / 2, H * 0.72); }
    } else {
      // portrait: words stacked
      const words = f.title.split(' ');
      words.forEach((w, i) => { fit(w, Math.round(W * 0.2), true, W * 0.86); g.fillText(w, W / 2, H * 0.25 + i * W * 0.24); });
      if (f.sub) { fit(f.sub, Math.round(W * 0.09), false, W * 0.9); g.fillText(f.sub, W / 2, H * 0.82); }
    }
  }, { repeat: false });
}
