import * as THREE from 'three/webgpu';
import type { LocoModelFile, ScreenKind } from '@rail/shared/train/Consist';
import type { LocoSystems } from '@rail/shared/train/LocoSystems';
import { loadPanelScene } from '../LocoModelLoader';
import type { CabReadings } from './CabControls';

type PanelFile = NonNullable<NonNullable<LocoModelFile['cab']>['panel']>;

export interface PanelExtra { station: string; stationDist: number }

/**
 * A separate 3D driver's console fitted inside a loco model's cab (the bullet
 * train). It is heavy, so it is loaded only when wanted (in the background once
 * the world is up, or on the way into the cab view), compiled before it is first
 * drawn, and kept while needed (a phone drops it after a while out of the cab).
 *
 * - its screen meshes show live values (canvas textures, redrawn 4 times a second)
 * - invisible hit boxes over its levers and buttons (panel.hits) make them clickable
 * - the model is not rigged: nothing moves, the controls just work
 */
export class PanelCab {
  /** loco body frame (shown in the cab view once loaded) */
  readonly group = new THREE.Group();
  /** the console's own frame (panel scale / rotation / offset): the model and its hit boxes */
  readonly inner = new THREE.Group();
  readonly hitTargets: THREE.Mesh[] = [];
  ready = false;
  /** seconds since the cab view was last used (phones drop the console after a while) */
  idle = 0;
  private loading: Promise<boolean> | null = null;
  private model: THREE.Object3D | null = null;
  private screens: { kind: ScreenKind; canvas: HTMLCanvasElement; tex: THREE.CanvasTexture }[] = [];
  private redraw = 0;

  constructor(private cfg: PanelFile, private locoId: string, private sys: LocoSystems) {
    this.inner.position.fromArray(cfg.offset);
    this.inner.rotation.set(...(cfg.rotationDeg.map(d => THREE.MathUtils.degToRad(d)) as [number, number, number]));
    this.inner.scale.setScalar(cfg.scale);
    this.group.add(this.inner);
    this.group.visible = false;
    const hitMat = new THREE.MeshBasicMaterial({ visible: false });
    for (const [id, h] of Object.entries(cfg.hits ?? {})) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(...h.size), hitMat);
      m.position.fromArray(h.at);
      m.userData.control = id;
      this.inner.add(m);
      this.hitTargets.push(m);
    }
  }

  /** Load (once, or again after drop()), fit, wire the screens, compile. Resolves true when ready. */
  load(compile: (o: THREE.Object3D) => Promise<unknown>) {
    if (this.ready) return Promise.resolve(true);
    if (!this.loading) this.loading = this.build(compile).finally(() => { this.loading = null; });
    return this.loading;
  }

  private async build(compile: (o: THREE.Object3D) => Promise<unknown>) {
    try {
      const scene = await loadPanelScene(this.locoId, this.cfg);
      const drop = new Set(this.cfg.remove ?? []);
      const gone: THREE.Object3D[] = [];
      scene.traverse(o => { if (drop.has(o.name)) gone.push(o); });
      for (const o of gone) o.removeFromParent();
      scene.updateMatrixWorld(true);
      scene.traverse(o => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.castShadow = false; m.receiveShadow = false;
        // the occlusion / roughness / metal maps are a baked atlas on the second uv set (the export lost texCoord 1)
        const mat = m.material as THREE.MeshStandardMaterial;
        if (m.geometry.getAttribute('uv1')) for (const t of [mat.aoMap, mat.roughnessMap, mat.metalnessMap]) if (t) t.channel = 1;
        const kind = this.cfg.screens?.[m.name];
        if (kind) this.wireScreen(m, [kind].flat(), scene);
      });
      // compiled while still detached (compile only sees visible objects; nothing half-ready is drawn)
      await compile(scene);
      this.inner.add(scene);
      this.model = scene;
      this.redraw = 0;
      this.ready = true;
      return true;
    } catch (e) {
      console.warn("[cab] the driver's console could not be loaded", e);
      return false;
    }
  }

  /**
   * A screen mesh drawn by update(). The source UVs are ignored (they point into
   * the model's texture, often turned or mirrored): new ones are projected from
   * the screen's own plane, upright and read left to right from in front. A mesh
   * holding several screens side by side shows one kind each, left to right.
   */
  private wireScreen(m: THREE.Mesh, kinds: ScreenKind[], root: THREE.Object3D) {
    const g = (m.geometry as THREE.BufferGeometry).toNonIndexed();
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
    // measured in the console's own frame: an optimised mesh is stored quantised, under a
    // non-uniform scale that would shear the screen's axes
    m.updateWorldMatrix(true, false);
    const toRoot = root.matrixWorld.clone().invert().multiply(m.matrixWorld);
    const rp = Array.from({ length: pos.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(toRoot));
    const n = new THREE.Vector3(), nm = new THREE.Matrix3().getNormalMatrix(toRoot);
    for (let i = 0; i < nrm.count; i++) n.add(new THREE.Vector3().fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize());
    n.normalize();
    // the screen's up (the model's up laid on its plane) and right, as seen from in front
    const up = new THREE.Vector3(0, 1, 0).addScaledVector(n, -n.y).normalize();
    const right = new THREE.Vector3().crossVectors(up, n);
    // triangles left to right, split at the widest gaps into one group per screen
    const p = new THREE.Vector3(), tris = pos.count / 3;
    const along = (t: number) => (rp[t * 3].dot(right) + rp[t * 3 + 1].dot(right) + rp[t * 3 + 2].dot(right)) / 3;
    const order = [...Array(tris).keys()].sort((a, b) => along(a) - along(b));
    const gaps = order.slice(1).map((t, i) => ({ i: i + 1, d: along(t) - along(order[i]) })).sort((a, b) => b.d - a.d);
    const cuts = gaps.slice(0, kinds.length - 1).map(x => x.i).sort((a, b) => a - b);
    const groups = [0, ...cuts, tris].slice(0, -1).map((s, i, a) => order.slice(s, i + 1 < a.length ? a[i + 1] : tris));
    const outPos = new Float32Array(pos.count * 3), outN = new Float32Array(pos.count * 3), outUv = new Float32Array(pos.count * 2);
    const mats: THREE.Material[] = [];
    let w = 0;
    groups.forEach((ts, gi) => {
      const uvOf = screenUv(ts.flatMap(t => [rp[t * 3], rp[t * 3 + 1], rp[t * 3 + 2]]), right, up);
      g.addGroup(w, ts.length * 3, gi);
      for (const t of ts) for (let k = 0; k < 3; k++, w++) {
        p.fromBufferAttribute(pos, t * 3 + k);
        outPos.set([p.x, p.y, p.z], w * 3);
        outN.set([nrm.getX(t * 3 + k), nrm.getY(t * 3 + k), nrm.getZ(t * 3 + k)], w * 3);
        outUv.set(uvOf.uv(rp[t * 3 + k]), w * 2);
      }
      const canvas = document.createElement('canvas');
      canvas.width = 512; canvas.height = Math.round(512 / THREE.MathUtils.clamp(uvOf.aspect, 0.8, 6));
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      mats.push(new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
      this.screens.push({ kind: kinds[gi] ?? kinds[0], canvas, tex });
    });
    g.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(outN, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(outUv, 2));
    m.geometry = g;
    m.material = mats;
  }

  update(dt: number, r: CabReadings, x: PanelExtra) {
    this.idle = 0;
    if (!this.ready || (this.redraw -= dt) > 0) return;
    this.redraw = 0.25;
    const s = this.sys;
    const power = s.regen > 0 ? -100 * s.regen / s.loco.regen.notches : 100 * s.notch / s.loco.notches;
    for (const sc of this.screens) { drawScreen(sc.canvas, sc.kind, r, power, x); sc.tex.needsUpdate = true; }
  }

  /** Free the console's GPU memory (phones, long out of the cab); load() brings it back. */
  drop() {
    if (!this.model) return;
    this.model.traverse(o => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        for (const v of Object.values(mat)) if ((v as THREE.Texture | null)?.isTexture) (v as THREE.Texture).dispose();
        mat.dispose();
      }
    });
    this.model.removeFromParent();
    this.model = null;
    this.screens = [];
    this.ready = false;
  }
}

/**
 * Screen uvs. A plain quad (the usual screen) has the canvas pinned to its own
 * four corners, so the image lies on the glass whatever the screen's tilt or turn;
 * any other shape gets the canvas projected upright over its bounds.
 */
function screenUv(pts: THREE.Vector3[], right: THREE.Vector3, up: THREE.Vector3) {
  const corners: THREE.Vector3[] = [];
  for (const p of pts) if (!corners.some(c => c.distanceToSquared(p) < 1e-10)) corners.push(p);
  const h = (p: THREE.Vector3) => p.dot(right), v = (p: THREE.Vector3) => p.dot(up);
  if (corners.length === 4) {
    const best = (f: (p: THREE.Vector3) => number) => corners.reduce((a, b) => (f(b) > f(a) ? b : a));
    const tl = best(p => v(p) - h(p)), tr = best(p => v(p) + h(p)), br = best(p => h(p) - v(p)), bl = best(p => -v(p) - h(p));
    if (new Set([tl, tr, br, bl]).size === 4) {
      const at = new Map<THREE.Vector3, [number, number]>([[tl, [0, 1]], [tr, [1, 1]], [br, [1, 0]], [bl, [0, 0]]]);
      return {
        aspect: tl.distanceTo(tr) / Math.max(1e-6, tl.distanceTo(bl)),
        uv: (p: THREE.Vector3) => at.get(corners.reduce((a, b) => (b.distanceToSquared(p) < a.distanceToSquared(p) ? b : a)))!,
      };
    }
  }
  let h0 = Infinity, h1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const p of pts) { h0 = Math.min(h0, h(p)); h1 = Math.max(h1, h(p)); v0 = Math.min(v0, v(p)); v1 = Math.max(v1, v(p)); }
  return { aspect: (h1 - h0) / Math.max(1e-6, v1 - v0), uv: (p: THREE.Vector3): [number, number] => [(h(p) - h0) / (h1 - h0 || 1), (v(p) - v0) / (v1 - v0 || 1)] };
}

const dist = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.max(0, Math.round(m))} m`);
const ASPECT: Record<string, string> = { R: '#ff3a2e', Y: '#ffcf3a', YY: '#ffcf3a', G: '#36e07c' };
const ASPECT_NAME: Record<string, string> = { R: 'STOP', Y: 'CAUTION', YY: 'ATTENTION', G: 'PROCEED' };
const INK = '#e8f4ff', DIM = '#7f93a6', BG = '#06090d', TRACK = '#1a232d';

/**
 * Live screens, laid out for their own shape (about 4:3): a title strip, then a
 * few large values well inside the bezel. Units: m = H / 100.
 */
function drawScreen(c: HTMLCanvasElement, kind: ScreenKind, r: CabReadings, power: number, x: PanelExtra) {
  const g = c.getContext('2d')!, W = c.width, H = c.height, m = H / 100, L = W * 0.09, R = W * 0.91;
  const text = (s: string, px: number, cx: number, cy: number, col = INK, align: CanvasTextAlign = 'left', bold = false) => {
    g.font = `${bold ? 'bold ' : ''}${Math.round(px * m)}px Arial`; g.fillStyle = col; g.textAlign = align; g.fillText(s, cx, cy);
  };
  const bar = (y: number, h: number, v: number, col: string) => {
    g.fillStyle = TRACK; g.fillRect(L, y, R - L, h);
    g.fillStyle = col; g.fillRect(L, y, (R - L) * THREE.MathUtils.clamp(v, 0, 1), h);
  };
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = BG; g.fillRect(0, 0, W, H);
  // a little margin inside the bezel
  g.setTransform(0.94, 0, 0, 0.94, W * 0.03, H * 0.03);
  g.textBaseline = 'middle';
  const title = (s: string) => { g.fillStyle = '#0f1a26'; g.fillRect(0, 0, W, 15 * m); text(s, 9, L, 8 * m, DIM, 'left', true); };

  if (kind === 'main') {
    title('SPEED');
    text(r.clock, 9, R, 8 * m, DIM, 'right');
    const over = r.speedKmph > r.limit + 2;
    text(String(Math.round(r.displaySpeed)), 34, L, 37 * m, over ? '#ff4a3a' : INK, 'left', true);
    text(r.units, 9, L, 57 * m, DIM);
    // limit roundel
    const cx = R - 13 * m, cy = 37 * m;
    g.fillStyle = '#fff'; g.beginPath(); g.arc(cx, cy, 13 * m, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#e03a2e'; g.lineWidth = 3 * m; g.beginPath(); g.arc(cx, cy, 11.5 * m, 0, Math.PI * 2); g.stroke();
    text(String(r.limit), 11, cx, cy + m, '#111', 'center', true);
    // speed against the limit
    const top = Math.max(r.limit, 1) * 1.25;
    bar(66 * m, 6 * m, r.displaySpeed / top, over ? '#ff4a3a' : '#36e07c');
    g.fillStyle = '#ff4a3a'; g.fillRect(L + (R - L) * (r.limit / top) - m * 0.6, 63 * m, 1.2 * m, 12 * m);
    // next station
    text(x.station || '-', 9, L, 88 * m, INK, 'left', true);
    if (x.station) text(dist(x.stationDist), 9, R, 88 * m, DIM, 'right');
  } else if (kind === 'power') {
    const brake = power < 0;
    title(brake ? 'REGEN BRAKE' : 'TRACTION');
    text(`${Math.round(Math.abs(power))}%`, 28, L, 36 * m, brake ? '#ffb52e' : INK, 'left', true);
    text(`${Math.round(r.teKN)} kN`, 11, R, 36 * m, DIM, 'right');
    bar(52 * m, 7 * m, Math.abs(power) / 100, brake ? '#ffb52e' : '#36e07c');
    const live = !r.pantoDown && !r.vcbOpen;
    text(`${r.kV.toFixed(1)} kV`, 10, L, 73 * m, live ? INK : DIM, 'left', true);
    text(`${Math.round(r.amps)} A`, 10, R, 73 * m, live ? INK : DIM, 'right', true);
    text(`${r.pantoDown ? 'PANTO DOWN' : 'PANTO UP'}   ${r.vcbOpen ? 'VCB OPEN' : 'VCB CLOSED'}`, 7.5, W / 2, 89 * m, r.pantoDown || r.vcbOpen ? '#ffb52e' : '#36e07c', 'center', true);
  } else if (kind === 'signal') {
    title('NEXT SIGNAL');
    const col = ASPECT[r.aspect] ?? '#3a4048';
    const lamp = (cx: number) => { g.fillStyle = col; g.beginPath(); g.arc(cx, 44 * m, 14 * m, 0, Math.PI * 2); g.fill(); };
    if (r.aspect === 'YY') { lamp(W / 2 - 16 * m); lamp(W / 2 + 16 * m); } else lamp(W / 2);
    text(ASPECT_NAME[r.aspect] ?? 'NO SIGNAL', 9, W / 2, 68 * m, col, 'center', true);
    text(r.nextSignal, 8, L, 87 * m, INK);
    text(r.signalDist < 99000 ? dist(r.signalDist) : '', 9, R, 87 * m, INK, 'right', true);
  } else {
    title('BRAKES  kg/cm²');
    ([['BP', r.bp, 6, '#5fb3ff'], ['BC', r.bc, 6, r.bc > 0.3 ? '#ffb52e' : '#5fb3ff'], ['MR', r.mr, 12, '#5fb3ff']] as const).forEach(([n, v, max, col], i) => {
      const y = (32 + i * 25) * m;
      text(n, 10, L, y, DIM, 'left', true);
      text(v.toFixed(1), 10, R, y, INK, 'right', true);
      g.fillStyle = TRACK; g.fillRect(L + 20 * m, y - 4 * m, R - L - 48 * m, 8 * m);
      g.fillStyle = col; g.fillRect(L + 20 * m, y - 4 * m, (R - L - 48 * m) * Math.min(1, v / max), 8 * m);
    });
  }
}
