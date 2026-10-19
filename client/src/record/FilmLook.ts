import * as THREE from 'three/webgpu';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js';
import type { Flat } from '@rail/shared/record/SceneFile';
import type { Studio } from './host';

export type LookId = 'natural' | 'golden' | 'monsoon' | 'teal' | 'vintage' | 'bw';
/** Colour looks: lift (shadows), gain (highlights), saturation and contrast, applied after tone mapping. */
const LOOKS: Record<LookId, { name: string; lift: number[]; gain: number[]; sat: number; con: number }> = {
  natural: { name: 'Natural', lift: [0, 0, 0], gain: [1, 1, 1], sat: 1, con: 1 },
  golden: { name: 'Warm golden', lift: [0.02, 0.01, 0], gain: [1.08, 1.0, 0.84], sat: 1.12, con: 1.04 },
  monsoon: { name: 'Monsoon', lift: [0.01, 0.025, 0.03], gain: [0.93, 1.0, 1.02], sat: 0.78, con: 0.94 },
  teal: { name: 'Night teal', lift: [0, 0.035, 0.05], gain: [1.06, 0.98, 0.9], sat: 1.05, con: 1.12 },
  vintage: { name: 'Vintage film', lift: [0.07, 0.055, 0.04], gain: [1.04, 0.98, 0.86], sat: 0.72, con: 0.88 },
  bw: { name: 'Black & white', lift: [0, 0, 0], gain: [1, 1, 1], sat: 0, con: 1.15 },
};
const LENSES = [14, 24, 35, 50, 85, 135];
/** vertical field of view of a full-frame lens (24 mm tall sensor) */
const lensFov = (mm: number) => (2 * Math.atan(12 / mm) * 180) / Math.PI;

const DEFAULTS = {
  fov: 0, focus: 'off' as 'off' | 'auto' | 'tap', blur: 0.5, motion: 'off' as 'off' | 'light' | 'strong',
  letterbox: 'none' as 'none' | '16:9' | '2.39', thirds: false, v916: false, square: false,
  look: 'natural' as LookId, exposure: 0, contrast: 1, saturation: 1, grain: 0, vignette: 0, flare: false,
};
type FilmSettings = typeof DEFAULTS;

const GRADE = {
  uniforms: {
    tDiffuse: { value: null }, exposure: { value: 1 }, contrast: { value: 1 }, saturation: { value: 1 },
    lift: { value: new THREE.Vector3() }, gain: { value: new THREE.Vector3(1, 1, 1) },
    grain: { value: 0 }, vignette: { value: 0 }, time: { value: 0 }, aspect: { value: 16 / 9 }, target: { value: 0 },
  },
  vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float exposure, contrast, saturation, grain, vignette, time, aspect, target; uniform vec3 lift, gain;
    varying vec2 vUv;
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb * exposure;
      c = c * gain + lift * (1.0 - c);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, saturation);
      c = (c - 0.5) * contrast + 0.5;
      vec2 q = vUv - 0.5; q.x *= aspect;
      c *= 1.0 - vignette * smoothstep(0.3, 1.0, length(q) * 1.25);
      float n = fract(sin(dot(floor(vUv * vec2(aspect * 720.0, 720.0)) + fract(time) * 97.0, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
      c += n * grain * 0.16;
      if (target > 0.0) {
        if (aspect < target) { if (abs(vUv.y - 0.5) > 0.5 * aspect / target) c = vec3(0.0); }
        else if (abs(vUv.x - 0.5) > 0.5 * target / aspect) c = vec3(0.0);
      }
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};

/** A soft radial sprite for the lens flare (drawn once). */
function flareTexture(size: number, ring: boolean) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d')!, r = size / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  if (ring) { grad.addColorStop(0, 'rgba(255,255,255,0)'); grad.addColorStop(0.75, 'rgba(255,240,220,0.0)'); grad.addColorStop(0.88, 'rgba(255,230,200,0.5)'); grad.addColorStop(1, 'rgba(255,255,255,0)'); }
  else { grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.2, 'rgba(255,240,210,0.6)'); grad.addColorStop(1, 'rgba(255,220,180,0)'); }
  g.fillStyle = grad; g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Record Mode's film settings: lens (field of view), focus blur, motion blur,
 * letterbox, frame guides, colour looks, grain, vignette and lens flare, plus
 * the soft outline round the selected train while the UI is on screen.
 * Post effects need the classic WebGL renderer (the default); on WebGPU only
 * the lens and the guides apply.
 */
export class FilmLook {
  s: FilmSettings = { ...DEFAULTS };
  readonly el = document.createElement('details');
  readonly guides = document.createElement('div');
  private bokeh: BokehPass | null = null;
  private outline: OutlinePass | null = null;
  private after: AfterimagePass | null = null;
  private grade: ShaderPass | null = null;
  private flare: Lensflare | null = null;
  private flareAnchor = new THREE.Object3D();
  private sig = '';
  /** tap-to-focus point (world) */
  focusAt: THREE.Vector3 | null = null;
  /** what the outline goes round (the selected train), or null */
  outlined: (() => THREE.Object3D[] | null) = () => null;
  focusTarget: (() => THREE.Vector3 | null) = () => null;
  private supported: boolean;

  constructor(private st: Studio) {
    this.supported = st.h.rs.kind === 'webgl';
    this.el.className = 'rec-film';
    this.el.open = true;
    this.guides.className = 'rec-guides';
    document.body.appendChild(this.guides);
    st.h.scene.add(this.flareAnchor);
    this.render();
  }

  get fov() { return this.s.fov > 0 ? this.s.fov : null; }

  /** Zoom (arrow keys while recording): the field of view from where it is now, `rate` per second (+ wider, - narrower). */
  zoom(rate: number, dt: number) {
    const now = this.s.fov > 0 ? this.s.fov : this.st.h.cameras.camera.fov;
    this.s.fov = Math.max(5, Math.min(100, now * Math.exp(rate * dt)));
  }

  /** The next wider (-1) or longer (+1) lens from the field of view now. */
  stepLens(dir: 1 | -1) {
    const now = this.s.fov > 0 ? this.s.fov : this.st.h.cameras.camera.fov;
    const fovs = LENSES.map(lensFov); // wide to long: falling field of view
    const next = dir > 0 ? fovs.find(f => f < now - 0.05) : [...fovs].reverse().find(f => f > now + 0.05);
    if (next !== undefined) this.s.fov = next;
    return LENSES[fovs.indexOf(this.s.fov)] ?? null;
  }

  /** Build or drop passes to match the settings (only when something changed). */
  private sync() {
    if (!this.supported) return;
    const h = this.st.h, s = this.s, ui = this.st.uiVisible();
    const wantOutline = ui && !!this.outlined();
    const grade = s.look !== 'natural' || s.exposure !== 0 || s.contrast !== 1 || s.saturation !== 1 || s.grain > 0 || s.vignette > 0 || s.letterbox !== 'none';
    const sig = [s.focus !== 'off', wantOutline, s.motion, grade].join();
    if (sig === this.sig) return;
    this.sig = sig;
    const size = h.rs.renderer.domElement;
    if (s.focus !== 'off') this.bokeh ??= new BokehPass(h.scene, h.rcam, { focus: 30, aperture: 0.0001, maxblur: 0.01 });
    if (wantOutline && !this.outline) {
      this.outline = new OutlinePass(new THREE.Vector2(size.width, size.height), h.scene, h.rcam);
      this.outline.edgeStrength = 2.2; this.outline.edgeGlow = 0.6; this.outline.edgeThickness = 1.5;
      this.outline.visibleEdgeColor.set('#f4f4ff'); this.outline.hiddenEdgeColor.set('#4a5060');
    }
    if (s.motion !== 'off') this.after ??= new AfterimagePass(0.6);
    if (grade) this.grade ??= new ShaderPass(GRADE);
    const pre = [s.focus !== 'off' ? this.bokeh : null, wantOutline ? this.outline : null, s.motion !== 'off' ? this.after : null].filter(Boolean) as BokehPass[];
    h.rs.setFilmPasses(pre, grade ? [this.grade!] : []);
  }

  /** Every frame, after the cameras moved: lens, focus distance, motion blur strength, outline, grade uniforms, flare. */
  afterCamera() {
    const h = this.st.h, s = this.s;
    if (this.fov) h.cameras.camera.fov = this.fov;
    this.sync();
    if (this.bokeh && s.focus !== 'off') {
      const p = s.focus === 'tap' ? this.focusAt : this.focusTarget();
      const cam = h.cameras.camera.position;
      const d = p ? p.distanceTo(cam) : 40;
      const u = this.bokeh.uniforms as Record<string, { value: number }>;
      u.focus.value += (d - u.focus.value) * 0.15;
      u.aperture.value = s.blur * 0.00025;
      u.maxblur.value = 0.003 + s.blur * 0.017;
    }
    if (this.after) (this.after.uniforms as Record<string, { value: number }>).damp.value = s.motion === 'strong' ? 0.82 : 0.6;
    if (this.outline) this.outline.selectedObjects = this.outlined() ?? [];
    if (this.grade) {
      const u = this.grade.uniforms as Record<string, { value: any }>, L = LOOKS[s.look];
      u.exposure.value = Math.pow(2, s.exposure);
      u.contrast.value = L.con * s.contrast;
      u.saturation.value = L.sat * s.saturation;
      u.lift.value.fromArray(L.lift); u.gain.value.fromArray(L.gain);
      u.grain.value = s.grain; u.vignette.value = s.vignette;
      u.time.value = performance.now() / 1000;
      const c = h.canvas;
      u.aspect.value = c.width / Math.max(1, c.height);
      u.target.value = s.letterbox === '16:9' ? 16 / 9 : s.letterbox === '2.39' ? 2.39 : 0;
    }
    this.updateFlare();
    this.placeGuides();
  }

  private updateFlare() {
    const h = this.st.h, on = this.s.flare && this.supported && h.time.day > 0.25 && h.time.sunDir.y > 0.02;
    if (on && !this.flare) {
      const lf = new Lensflare(), main = flareTexture(256, false), ring = flareTexture(128, true);
      lf.addElement(new LensflareElement(main, 420, 0, new THREE.Color(1, 0.95, 0.85)));
      lf.addElement(new LensflareElement(ring, 90, 0.4, new THREE.Color(0.7, 0.85, 1)));
      lf.addElement(new LensflareElement(main, 50, 0.6, new THREE.Color(1, 0.8, 0.5)));
      lf.addElement(new LensflareElement(ring, 160, 0.85, new THREE.Color(0.6, 1, 0.7)));
      lf.addElement(new LensflareElement(main, 30, 1.0, new THREE.Color(0.8, 0.7, 1)));
      this.flare = lf;
      this.flareAnchor.add(lf);
    }
    if (this.flare) this.flare.visible = on;
    if (on) this.flareAnchor.position.copy(h.rcam.position).addScaledVector(h.time.sunDir, 2000);
  }

  /** Frame guides over the picture (thirds, 9:16, 1:1), inside the letterbox, only while the UI shows. */
  private placeGuides() {
    const s = this.s, g = this.guides;
    const show = this.st.uiVisible() && (s.thirds || s.v916 || s.square);
    g.hidden = !show;
    if (!show) return;
    const r = this.st.h.canvas.getBoundingClientRect();
    let w = r.width, hh = r.height;
    const t = s.letterbox === '16:9' ? 16 / 9 : s.letterbox === '2.39' ? 2.39 : 0;
    if (t) { if (w / hh < t) hh = w / t; else w = hh * t; }
    const key = `${r.left},${r.top},${w},${hh},${s.thirds},${s.v916},${s.square}`;
    if (g.dataset.key === key) return;
    g.dataset.key = key;
    Object.assign(g.style, { left: `${r.left + (r.width - w) / 2}px`, top: `${r.top + (r.height - hh) / 2}px`, width: `${w}px`, height: `${hh}px` });
    const box = (bw: number) => `<div class="box" style="width:${bw}px;left:${(w - bw) / 2}px"></div>`;
    g.innerHTML = (s.thirds ? '<i class="v" style="left:33.33%"></i><i class="v" style="left:66.66%"></i><i class="h" style="top:33.33%"></i><i class="h" style="top:66.66%"></i>' : '')
      + (s.v916 ? box((hh * 9) / 16) : '') + (s.square ? box(hh) : '');
  }

  toScene(): Flat { return { ...this.s }; }
  fromScene(f: Flat) {
    const s: Record<string, unknown> = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS) as (keyof FilmSettings)[]) if (typeof f[k] === typeof DEFAULTS[k]) s[k] = f[k];
    if (!(s.look as string in LOOKS)) s.look = 'natural';
    this.s = s as FilmSettings;
    this.render();
  }

  render() {
    const s = this.s;
    const sl = (k: keyof FilmSettings, label: string, min: number, max: number, step: number, unit = '') => `<label>${label} <input type="range" min="${min}" max="${max}" step="${step}" value="${s[k]}" data-f="${k}"><output>${Number((s[k] as number).toFixed(2))}${unit}</output></label>`;
    const sel = (k: keyof FilmSettings, label: string, opts: [string, string][]) => `<label>${label} <select data-f="${k}">${opts.map(([v, n]) => `<option value="${v}" ${String(s[k]) === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>`;
    const tog = (k: keyof FilmSettings, label: string) => `<label class="tog"><input type="checkbox" data-f="${k}" ${s[k] ? 'checked' : ''}><span>${label}</span></label>`;
    this.el.innerHTML = `<summary>Film</summary>
      ${this.supported ? '' : '<p class="note warn">Focus blur, motion blur, looks, grain and flare need the WebGL renderer (Settings &rarr; Renderer). Lens and guides work.</p>'}
      <div class="rec-modes small"><button data-lens="0" class="${s.fov ? '' : 'on'}">Camera's own</button>${LENSES.map(mm => `<button data-lens="${mm}" class="${Math.abs(s.fov - lensFov(mm)) < 0.05 ? 'on' : ''}">${mm} mm</button>`).join('')}</div>
      ${sl('fov', 'Field of view', 0, 100, 0.5, '&deg;')}
      ${sel('focus', 'Background blur', [['off', 'Off'], ['auto', 'Auto (on the followed train)'], ['tap', 'Tap to focus']])}
      ${s.focus !== 'off' ? sl('blur', 'Blur strength', 0, 1, 0.05) : ''}
      ${s.focus === 'tap' ? '<div class="buttons left"><button data-fa="tap">Pick focus point&hellip;</button></div>' : ''}
      ${sel('motion', 'Motion blur', [['off', 'Off'], ['light', 'Light'], ['strong', 'Strong']])}
      ${sel('letterbox', 'Letterbox', [['none', 'None'], ['16:9', '16:9'], ['2.39', '2.39 : 1 (cinema)']])}
      <div class="row">${tog('thirds', 'Thirds')}${tog('v916', '9:16 frame')}${tog('square', '1:1 frame')}</div>
      <div class="rec-modes small">${(Object.keys(LOOKS) as LookId[]).map(k => `<button data-look="${k}" class="${s.look === k ? 'on' : ''}">${LOOKS[k].name}</button>`).join('')}</div>
      ${sl('exposure', 'Exposure', -2, 2, 0.05, ' EV')}${sl('contrast', 'Contrast', 0.5, 1.5, 0.01)}${sl('saturation', 'Saturation', 0, 2, 0.01)}
      ${sl('grain', 'Grain', 0, 1, 0.01)}${sl('vignette', 'Vignette', 0, 1, 0.01)}
      ${tog('flare', 'Lens flare (sun)')}
      <div class="buttons left"><button data-fa="reset">Reset film settings</button></div>`;
  }

  bind() {
    this.el.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      if (b.dataset.lens !== undefined) { const mm = Number(b.dataset.lens); this.s.fov = mm ? lensFov(mm) : 0; this.render(); }
      if (b.dataset.look) { this.s.look = b.dataset.look as LookId; this.render(); }
      if (b.dataset.fa === 'reset') { this.s = { ...DEFAULTS }; this.focusAt = null; this.render(); }
      if (b.dataset.fa === 'tap') this.st.pick('Click what should be sharp', hit => { this.focusAt = new THREE.Vector3(hit.x, hit.y, hit.z); });
    });
    const set = (t: HTMLInputElement, done: boolean) => {
      const k = t.dataset.f as keyof FilmSettings | undefined;
      if (!k) return;
      const v = t.type === 'checkbox' ? t.checked : t.type === 'range' ? Number(t.value) : t.value;
      (this.s as Record<string, unknown>)[k] = v;
      const out = t.nextElementSibling as HTMLOutputElement | null;
      if (t.type === 'range' && out) out.textContent = String(Number((v as number).toFixed(2))) + (k === 'fov' ? '°' : k === 'exposure' ? ' EV' : '');
      if (done && (t.tagName === 'SELECT' || k === 'fov')) this.render();
    };
    this.el.addEventListener('input', e => set(e.target as HTMLInputElement, false));
    this.el.addEventListener('change', e => set(e.target as HTMLInputElement, true));
  }

  dispose() {
    this.st.h.rs.setFilmPasses([], []);
    this.flareAnchor.removeFromParent();
    this.flare?.dispose();
    for (const p of [this.bokeh, this.outline, this.after, this.grade]) p?.dispose();
    this.guides.remove();
  }
}
