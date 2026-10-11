import * as THREE from 'three/webgpu';
import ADS from '../../../../data/ads.json';
import { GeoBatch, mat } from '../../core/GeoBatch';
import { canvasTexture } from '../../core/Textures';
import { materials } from '../../core/Materials';
import { hash2 } from '@rail/shared/util';
import { PROP_STRIDE } from './Placement';

/**
 * Roadside hoardings with real ads. Placement puts billboards beside the line;
 * each terrain tile hands its billboards here (they are not in the tile's
 * scenery batch, so each can show its own ad). A billboard is two steel
 * columns behind the panel with bracing, a framed 6.4 x 3.2 m panel, a
 * maintenance walkway with a railing and two lamp arms (the panel glows at
 * night). The ad on each is picked from data/ads.json by weight; an ad with
 * an image shows it (else a drawn text ad), and an ad with a url opens the
 * advertiser's site in a new tab when the billboard is clicked or tapped (a
 * tap, not a drag: looking around never opens anything).
 */

interface AdData { id: string; weight?: number; image?: string; url?: string; fallback?: { bg: string; fg: string; title: string; sub?: string } }
interface Ad { data: AdData; material: THREE.MeshStandardMaterial; url: string | null }

const PANEL_W = 6.4, PANEL_H = 3.2, PANEL_Y = 4.9; // panel bottom above the ground

/** Only plain http(s) links open (no javascript: or data: urls from a data file). */
function safeUrl(u?: string) {
  if (!u) return null;
  try { const p = new URL(u); return p.protocol === 'https:' || p.protocol === 'http:' ? p.href : null; } catch { return null; }
}

export class Billboards {
  readonly group = new THREE.Group();
  private ads: Ad[] = [];
  private weights: number[] = [];
  private frame: THREE.BufferGeometry;
  private frameMat: THREE.Material;
  private panelGeo = new THREE.PlaneGeometry(PANEL_W, PANEL_H).translate(0, PANEL_Y + PANEL_H / 2, 0.06);
  private tiles = new Map<string, { group: THREE.Group; panels: THREE.InstancedMesh[] }>();
  private raycaster = new THREE.Raycaster();
  private down: { x: number; y: number; t: number } | null = null;
  private hoverAt = 0;

  constructor(private dom: HTMLElement, private camera: () => THREE.Camera) {
    this.group.name = 'billboards';
    const list = ((ADS as { ads: AdData[] }).ads ?? []).filter(a => a.image || a.fallback);
    for (const data of list) {
      const fallback = drawnAd(data);
      const material = new THREE.MeshStandardMaterial({ map: fallback, roughness: 0.55, emissive: new THREE.Color(0xffffff), emissiveMap: fallback, emissiveIntensity: 0 });
      if (data.image) {
        new THREE.TextureLoader().load(data.image.replace(/^\//, ''), t => {
          t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
          material.map = t; material.emissiveMap = t; // same shader (both maps already set): no recompile
        }, undefined, () => console.warn(`[ads] ${data.id}: image ${data.image} not found, showing the text ad`));
      }
      this.ads.push({ data, material, url: safeUrl(data.url) });
      this.weights.push(Math.max(0, data.weight ?? 1));
    }
    const b = new GeoBatch();
    // two columns behind the panel, cross bracing, the panel's back sheet and frame, walkway, railing, lamp arms
    const back = -0.35;
    for (const x of [-1.9, 1.9]) b.box(0.3, PANEL_Y + PANEL_H + 0.2, 0.3, mat(x, (PANEL_Y + PANEL_H + 0.2) / 2, back), '#5c6166', 'metal');
    for (const y of [1.6, 3.4]) b.box(3.8, 0.12, 0.12, mat(0, y, back, 0, 0, y < 2 ? 0.45 : -0.45), '#5c6166', 'metal');
    b.box(PANEL_W + 0.3, PANEL_H + 0.3, 0.12, mat(0, PANEL_Y + PANEL_H / 2, -0.04), '#3c4044', 'metal');      // back sheet
    for (const [w, h, x, y] of [[PANEL_W + 0.3, 0.16, 0, PANEL_Y - 0.07], [PANEL_W + 0.3, 0.16, 0, PANEL_Y + PANEL_H + 0.07], [0.16, PANEL_H + 0.3, -PANEL_W / 2 - 0.07, PANEL_Y + PANEL_H / 2], [0.16, PANEL_H + 0.3, PANEL_W / 2 + 0.07, PANEL_Y + PANEL_H / 2]] as const)
      b.box(w, h, 0.2, mat(x, y, 0.06), '#e9e9e4', 'metal');                                                   // frame
    b.box(PANEL_W + 0.4, 0.08, 0.9, mat(0, PANEL_Y - 0.55, 0.45), '#4a4f53', 'metal');                         // walkway
    b.box(PANEL_W + 0.4, 0.05, 0.05, mat(0, PANEL_Y + 0.45, 0.88), '#c9cdd1', 'metal');                         // railing
    for (let x = -PANEL_W / 2; x <= PANEL_W / 2 + 0.01; x += PANEL_W / 4) b.box(0.05, 1.0, 0.05, mat(x, PANEL_Y - 0.05, 0.88), '#c9cdd1', 'metal');
    for (const x of [-1.6, 1.6]) {
      b.box(0.06, 0.06, 1.2, mat(x, PANEL_Y + PANEL_H + 0.25, 0.55), '#3c4044', 'metal');                        // lamp arm
      b.box(0.5, 0.12, 0.22, mat(x, PANEL_Y + PANEL_H + 0.2, 1.1), '#fff3c4', 'metal');                         // lamp
    }
    this.frame = b.geometry('metal')!;
    this.frameMat = materials().metal;
    dom.addEventListener('pointerdown', this.onDown);
    dom.addEventListener('pointerup', this.onUp);
    dom.addEventListener('pointermove', this.onMove);
  }

  /** A tile's billboards (PROP_STRIDE floats each, world coordinates), or null when the tile goes. */
  setTile(key: string, arr: Float32Array | null) {
    const old = this.tiles.get(key);
    if (old) { old.group.removeFromParent(); for (const p of old.panels) p.dispose(); this.tiles.delete(key); }
    if (!arr || !arr.length || !this.ads.length) return;
    const n = arr.length / PROP_STRIDE;
    const g = new THREE.Group();
    const frames = new THREE.InstancedMesh(this.frame, this.frameMat, n);
    frames.castShadow = true; frames.receiveShadow = true;
    const byAd = new Map<number, THREE.Matrix4[]>();
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const o = i * PROP_STRIDE;
      p.set(arr[o], arr[o + 1], arr[o + 2]);
      q.setFromAxisAngle(up, arr[o + 3]);
      m.compose(p, q, s);
      frames.setMatrixAt(i, m);
      const ad = this.pick(hash2(Math.round(arr[o]), Math.round(arr[o + 2]), 97));
      (byAd.get(ad) ?? byAd.set(ad, []).get(ad)!).push(m.clone());
    }
    frames.computeBoundingSphere();
    g.add(frames);
    const panels: THREE.InstancedMesh[] = [];
    for (const [ad, mats] of byAd) {
      const im = new THREE.InstancedMesh(this.panelGeo, this.ads[ad].material, mats.length);
      mats.forEach((mm, i) => im.setMatrixAt(i, mm));
      im.userData.ad = ad;
      im.receiveShadow = true;
      im.computeBoundingSphere();
      g.add(im);
      panels.push(im);
    }
    this.group.add(g);
    this.tiles.set(key, { group: g, panels });
  }

  private pick(h: number) {
    const total = this.weights.reduce((a, w) => a + w, 0) || 1;
    let x = h * total;
    for (let i = 0; i < this.weights.length; i++) { x -= this.weights[i]; if (x < 0) return i; }
    return this.weights.length - 1;
  }

  /** Panels glow a little at night (lit by their lamps). */
  update(night: number) {
    for (const a of this.ads) a.material.emissiveIntensity = night * 0.55;
  }

  // ------------------------------------------------------------------ clicking an ad
  private hit(e: PointerEvent): Ad | null {
    const r = this.dom.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera());
    this.raycaster.far = 400;
    const panels = [...this.tiles.values()].flatMap(t => t.panels);
    const h = this.raycaster.intersectObjects(panels, false)[0];
    return h ? this.ads[h.object.userData.ad as number] : null;
  }
  private onDown = (e: PointerEvent) => { this.down = { x: e.clientX, y: e.clientY, t: performance.now() }; };
  private onUp = (e: PointerEvent) => {
    const d = this.down; this.down = null;
    // a click or tap, not a look-around drag
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8 || performance.now() - d.t > 500) return;
    const ad = this.hit(e);
    if (ad?.url) window.open(ad.url, '_blank', 'noopener,noreferrer');
  };
  private onMove = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse' || e.buttons) return;
    const now = performance.now();
    if (now - this.hoverAt < 120) return;
    this.hoverAt = now;
    this.dom.style.cursor = this.hit(e)?.url ? 'pointer' : '';
  };

  dispose() {
    this.dom.removeEventListener('pointerdown', this.onDown);
    this.dom.removeEventListener('pointerup', this.onUp);
    this.dom.removeEventListener('pointermove', this.onMove);
    for (const k of [...this.tiles.keys()]) this.setTile(k, null);
  }
}

/** A text ad drawn on a canvas (ads without an image, and while an image loads). */
function drawnAd(a: AdData) {
  const f = a.fallback ?? { bg: '#2c3e50', fg: '#ffffff', title: a.id.toUpperCase() };
  return canvasTexture(`ad-${a.id}`, 512, 256, g => {
    g.fillStyle = f.bg; g.fillRect(0, 0, 512, 256);
    g.fillStyle = f.fg; g.textAlign = 'center'; g.textBaseline = 'middle';
    let size = 64; g.font = `bold ${size}px Arial`;
    while (g.measureText(f.title).width > 470 && size > 20) { size -= 2; g.font = `bold ${size}px Arial`; }
    g.fillText(f.title, 256, f.sub ? 105 : 128);
    if (f.sub) { g.font = '34px Arial'; g.fillText(f.sub, 256, 180); }
  }, { repeat: false });
}
