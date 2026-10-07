import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { RenderSystem } from '../core/Renderer';
import { textures } from '../core/TextureLibrary';
import { canvasTexture, labelTexture, tex } from '../core/Textures';
import { grassTexture } from '../world/scenery/Vegetation';

/** Procedural stand-ins by manifest id, for entries without a processed file. */
const PROCEDURAL: Record<string, () => THREE.Texture> = {
  'structure/stone': tex.stone, 'structure/concrete': tex.concrete, 'structure/roof-tiles': tex.roof,
  'building/facade': () => tex.facade(false), 'vegetation/grass-blades': grassTexture, 'vegetation/tree-impostor': tex.treeImpostor,
};

type View = 'normal' | 'uv' | 'mips' | 'normals' | 'roughness';
interface Patch { id: string; mesh: THREE.Mesh; color: THREE.Texture | null; normal: THREE.Texture | null; roughness: THREE.Texture | null; seams: THREE.LineSegments | null; repeat: THREE.Vector2; owned: THREE.Texture[]; debugMap: THREE.Texture | null }

const PATCH = 20, GAP = 8, COLS = 6;

/** Box-projected UVs in metres (along the face's two other axes), so every texture shows at its real size. */
function metreUVs(g: THREE.BufferGeometry) {
  const p = g.getAttribute('position'), n = g.getAttribute('normal');
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    const [u, v] = ay >= ax && ay >= az ? [p.getX(i), -p.getZ(i)] : ax >= az ? [p.getZ(i), p.getY(i)] : [p.getX(i), p.getY(i)];
    uv[i * 2] = u; uv[i * 2 + 1] = v;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/** 1 m checker with arrows (shows UV direction and stretching). */
const checker = () => canvasTexture('uv-checker', 256, 256, (g, w, h) => {
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { g.fillStyle = (x + y) % 2 ? '#e8e8e8' : '#3a6ec4'; g.fillRect(x * w / 8, y * h / 8, w / 8, h / 8); }
  g.fillStyle = '#d23'; g.font = 'bold 70px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('F↑', w / 2, h / 2);
});

/** Each mip level a solid colour: red = full size, then orange, yellow, green, cyan, blue, violet... */
function mipTexture() {
  const cols = [[255, 40, 40], [255, 150, 0], [250, 230, 0], [40, 200, 60], [0, 210, 220], [40, 80, 255], [170, 60, 255], [255, 255, 255], [120, 120, 120], [40, 40, 40], [0, 0, 0]];
  const mipmaps: { data: Uint8Array; width: number; height: number }[] = [];
  for (let l = 0, s = 1024; s >= 1; l++, s >>= 1) {
    const d = new Uint8Array(s * s * 4), c = cols[Math.min(l, cols.length - 1)];
    for (let i = 0; i < s * s; i++) d.set([c[0], c[1], c[2], 255], i * 4);
    mipmaps.push({ data: d, width: s, height: s });
  }
  const t = new THREE.DataTexture(mipmaps[0].data, 1024, 1024);
  t.mipmaps = mipmaps as never;
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * God Mode -> Texture Test: a separate scene (the run stays paused) with a
 * patch of every texture in data/textures.json at real size and labelled,
 * a wall corner, a cliff, a track strip, a road and the name board, view
 * toggles (UV checker, mip colours, seams, wireframe, normals only,
 * roughness only), camera presets, and the list of every texture with its
 * source and size.
 */
export class TextureTest {
  private scene = new THREE.Scene();
  private cam = new THREE.PerspectiveCamera(55, 1, 0.05, 3000);
  private controls: OrbitControls;
  private patches: Patch[] = [];
  private ui: HTMLElement;
  private view: View = 'normal';
  private wire = false;
  private seamsOn = false;
  private checker = checker();
  private mips = mipTexture();
  private disposables: { dispose(): void }[] = [];

  constructor(private rs: RenderSystem, private close: () => void) {
    const size = { x: rs.renderer.domElement.clientWidth, y: rs.renderer.domElement.clientHeight };
    this.cam.aspect = size.x / Math.max(1, size.y);
    this.cam.updateProjectionMatrix();
    this.scene.background = new THREE.Color(0x8fb4d8);
    this.scene.add(new THREE.HemisphereLight(0xdde8ff, 0x55493a, 1.1));
    const sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
    sun.position.set(-60, 90, 40);
    this.scene.add(sun);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(600, 600).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x6b6b62, roughness: 1 }));
    floor.position.y = -0.02;
    this.scene.add(floor);
    this.disposables.push(floor.geometry, floor.material as THREE.Material, this.mips);
    this.controls = new OrbitControls(this.cam, rs.renderer.domElement);
    this.controls.enableDamping = true;
    this.ui = this.buildUi();
    document.body.appendChild(this.ui);
    void this.build();
    this.preset('10m');
    rs.setScene(this.scene, this.cam);
    rs.renderer.setAnimationLoop(() => { this.controls.update(); rs.render(); });
  }

  private async build() {
    const list = textures.report();
    const rows = this.ui.querySelector('tbody')!;
    rows.innerHTML = list.map(r => `<tr><td>${r.id}</td><td>${r.type}</td><td class="${r.source.startsWith('file') ? 'ok' : 'fb'}">${r.source}</td><td>${r.size}</td></tr>`).join('');
    let i = 0;
    for (const r of list) {
      const x = (i % COLS) * (PATCH + GAP), z = Math.floor(i / COLS) * (PATCH + GAP);
      i++;
      const e = await this.patch(r.id, r.type);
      if (!e) continue;
      e.mesh.position.x += x; e.mesh.position.z += z;
      if (e.seams) e.seams.position.copy(e.mesh.position);
      this.label(`${r.id}  ${r.size}  ${r.source}`, x + PATCH / 2, z - 0.5);
    }
    // scene pieces that catch the usual faults: corners, steep faces, grazing views, cut-outs
    const y0 = Math.ceil(i / COLS) * (PATCH + GAP) + 10;
    this.label('wall corner (station-wall / brick)', 6, y0 - 0.5, 15);
    await this.piece('station/station-wall', metreUVs(new THREE.BoxGeometry(6, 3, 6)), new THREE.Vector3(3, 1.5, y0 + 3));
    await this.piece('station/brick-red', metreUVs(new THREE.BoxGeometry(6, 3, 0.4)), new THREE.Vector3(3, 1.5, y0 + 7));
    this.label('cliff 60° (rock-cliff)', 22, y0 - 0.5, 15);
    await this.piece('terrain/rock-cliff', metreUVs(new THREE.BoxGeometry(14, 0.5, 18)), new THREE.Vector3(22, 5, y0 + 9), new THREE.Euler(Math.PI / 3, 0, 0));
    this.label('track (ballast + sleepers)', 40, y0 - 0.5, 15);
    await this.piece('track/ballast', metreUVs(new THREE.BoxGeometry(3.4, 0.35, 30)), new THREE.Vector3(40, 0.17, y0 + 15));
    const sleepers: THREE.BufferGeometry[] = [];
    for (let s = 0; s < 50; s++) sleepers.push(metreUVs(new THREE.BoxGeometry(2.75, 0.2, 0.25)).translate(0, 0, s * 0.6));
    await this.piece('track/sleeper-concrete', mergeGeometries(sleepers), new THREE.Vector3(40, 0.42, y0 + 0.3));
    this.label('road (dry-soil, tinted)', 56, y0 - 0.5, 15);
    const road = await this.piece('terrain/dry-soil', metreUVs(new THREE.BoxGeometry(6, 0.05, 30)), new THREE.Vector3(56, 0.03, y0 + 15));
    if (road) (road.mesh.material as THREE.MeshStandardMaterial).color.setScalar(0.62);
    this.label('name board (decal, alpha test)', 70, y0 - 0.5, 15);
    await this.piece('station/name-board-blank', new THREE.PlaneGeometry(4.2, 4.2).translate(0, 2.1, 0), new THREE.Vector3(70, 0, y0 + 2));
    this.label('facade box (procedural)', 86, y0 - 0.5, 15);
    await this.piece('building/facade', metreUVs(new THREE.BoxGeometry(12.4, 12.4, 8)), new THREE.Vector3(88, 6.2, y0 + 6));
    this.apply();
  }

  /** A flat patch (tiles), a standing wall (tile-x / tile-y), or one standing copy (atlas, sprite, decal: their own UVs). */
  private async patch(id: string, type: string) {
    if (type === 'tile') return this.piece(id, metreUVs(new THREE.PlaneGeometry(PATCH, PATCH).rotateX(-Math.PI / 2)), new THREE.Vector3(PATCH / 2, 0, PATCH / 2));
    if (type === 'tile-x' || type === 'tile-y') return this.piece(id, metreUVs(new THREE.PlaneGeometry(PATCH, 6)), new THREE.Vector3(PATCH / 2, 3, PATCH / 2));
    const s = type === 'decal' ? 4.2 : 6;
    return this.piece(id, new THREE.PlaneGeometry(s, s), new THREE.Vector3(PATCH / 2, s / 2, PATCH / 2));
  }

  private async piece(id: string, g: THREE.BufferGeometry, pos: THREE.Vector3, rot?: THREE.Euler) {
    const e = textures.manifestEntry(id);
    if (!e) return null;
    const set = await textures.loadSet(id, [1, 1]);
    const owned: THREE.Texture[] = [];
    let color = set?.color ?? null;
    if (!color && PROCEDURAL[id]) {
      color = PROCEDURAL[id]().clone();
      color.wrapS = color.wrapT = THREE.RepeatWrapping;
      color.repeat.set(1 / e.sizeM[0], 1 / e.sizeM[1]);
    }
    if (color) owned.push(color);
    if (set?.normal) owned.push(set.normal);
    if (set?.roughness) owned.push(set.roughness);
    const mat = new THREE.MeshStandardMaterial({ map: color, normalMap: set?.normal ?? null, roughnessMap: set?.roughness ?? null, roughness: 1, side: THREE.DoubleSide, alphaTest: e.alphaTest ?? 0, transparent: e.alpha && !e.alphaTest });
    if (!color) mat.color.set(0xff00ff);
    const mesh = new THREE.Mesh(g, mat);
    mesh.position.copy(pos);
    if (rot) mesh.rotation.copy(rot);
    this.scene.add(mesh);
    let seams: THREE.LineSegments | null = null;
    if (e.type.startsWith('tile')) {
      seams = new THREE.LineSegments(seamLines(g, e.sizeM), new THREE.LineBasicMaterial({ color: 0xff2050, depthTest: false }));
      seams.position.copy(pos);
      if (rot) seams.rotation.copy(rot);
      seams.renderOrder = 2;
      this.scene.add(seams);
      this.disposables.push(seams.geometry, seams.material as THREE.Material);
    }
    this.disposables.push(g, mat);
    const p: Patch = { id, mesh, color, normal: set?.normal ?? null, roughness: set?.roughness ?? null, seams, repeat: color?.repeat.clone() ?? new THREE.Vector2(1, 1), owned, debugMap: null };
    this.patches.push(p);
    return p;
  }

  /** Flat on the ground in front of a patch (readable from above, out of the way at grazing angles). */
  private label(text: string, x: number, z: number, w = PATCH + GAP - 1) {
    const t = labelTexture(text, { w: 1024, h: 96, bg: '#111', fg: '#fff' });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, w / (PATCH + GAP - 1) * 2.6).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: t, side: THREE.DoubleSide }));
    m.position.set(x, 0.02, z - 1.4);
    this.scene.add(m);
    this.disposables.push(m.geometry, m.material as THREE.Material);
  }

  /** Apply the view toggles to every patch. */
  private apply() {
    for (const p of this.patches) {
      const old = p.mesh.material as THREE.Material;
      let m: THREE.Material;
      if (this.view === 'normals') m = new THREE.MeshNormalMaterial({ normalMap: p.normal, side: THREE.DoubleSide, toneMapped: false } as never);
      else if (this.view === 'roughness') m = new THREE.MeshBasicMaterial({ map: p.roughness, color: p.roughness ? 0xffffff : 0x808080, side: THREE.DoubleSide, toneMapped: false });
      else {
        p.debugMap?.dispose();
        p.debugMap = this.view === 'uv' ? this.checker.clone() : this.view === 'mips' ? this.mips.clone() : null;
        if (p.debugMap) { p.debugMap.repeat.copy(p.repeat); p.debugMap.wrapS = p.debugMap.wrapT = THREE.RepeatWrapping; }
        const map = p.debugMap ?? p.color;
        m = new THREE.MeshStandardMaterial({ map, normalMap: this.view === 'normal' ? p.normal : null, roughnessMap: this.view === 'normal' ? p.roughness : null, roughness: 1, side: THREE.DoubleSide, alphaTest: (old as THREE.MeshStandardMaterial).alphaTest, transparent: old.transparent });
        if (!map) (m as THREE.MeshStandardMaterial).color.set(0xff00ff);
      }
      (m as THREE.MeshBasicMaterial).wireframe = this.wire;
      p.mesh.material = m;
      old.dispose();
      if (p.seams) p.seams.visible = this.seamsOn;
    }
  }

  preset(k: 'close' | '10m' | '100m' | 'grazing') {
    const c = new THREE.Vector3(PATCH / 2, 0, PATCH / 2);
    const at = { close: [c.x, 1.2, c.z + 1.5], '10m': [c.x, 10, c.z + 6], '100m': [80, 115, 245], grazing: [-10, 1.6, c.z] }[k];
    this.cam.position.set(at[0], at[1], at[2]);
    this.controls.target.copy(k === '100m' ? new THREE.Vector3(80, 0, 90) : k === 'grazing' ? new THREE.Vector3(160, 0, c.z) : c);
    this.controls.update();
  }

  private buildUi() {
    const el = document.createElement('div');
    el.className = 'tex-test';
    el.innerHTML = `
      <div class="tt-bar">
        <b>Texture Test</b>
        <label><input type="radio" name="tt-v" value="normal" checked> Normal</label>
        <label><input type="radio" name="tt-v" value="uv"> UV checker</label>
        <label><input type="radio" name="tt-v" value="mips"> Mip colours</label>
        <label><input type="radio" name="tt-v" value="normals"> Normals only</label>
        <label><input type="radio" name="tt-v" value="roughness"> Roughness only</label>
        <label><input type="checkbox" data-t="seams"> Seams</label>
        <label><input type="checkbox" data-t="wire"> Wireframe</label>
        <span class="tt-sep"></span>
        <button data-c="close">Close-up</button><button data-c="10m">10 m</button><button data-c="100m">100 m</button><button data-c="grazing">Grazing</button>
        <button data-a="list">List</button><button data-a="exit">Back</button>
      </div>
      <div class="tt-list" hidden><table><thead><tr><th>id</th><th>type</th><th>source</th><th>size</th></tr></thead><tbody></tbody></table></div>`;
    el.addEventListener('change', e => {
      const t = e.target as HTMLInputElement;
      if (t.name === 'tt-v') this.view = t.value as View;
      if (t.dataset.t === 'seams') this.seamsOn = t.checked;
      if (t.dataset.t === 'wire') this.wire = t.checked;
      this.apply();
    });
    el.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      if (b.dataset.c) this.preset(b.dataset.c as 'close');
      if (b.dataset.a === 'list') { const l = el.querySelector<HTMLElement>('.tt-list')!; l.hidden = !l.hidden; }
      if (b.dataset.a === 'exit') this.dispose();
    });
    return el;
  }

  dispose() {
    this.rs.renderer.setAnimationLoop(null);
    this.controls.dispose();
    this.ui.remove();
    for (const p of this.patches) { (p.mesh.material as THREE.Material).dispose(); p.debugMap?.dispose(); for (const t of p.owned) t.dispose(); }
    this.checker.dispose();
    for (const d of this.disposables) d.dispose();
    this.close();
  }
}

/** Lines along every texture-copy boundary of a geometry with metre UVs (local space). */
function seamLines(g: THREE.BufferGeometry, sizeM: [number, number]) {
  const p = g.getAttribute('position'), uv = g.getAttribute('uv'), idx = g.getIndex();
  const out: number[] = [];
  const tri = (a: number, b: number, c: number) => {
    for (let k = 0; k < 2; k++) {
      const u = [a, b, c].map(i => uv.getComponent(i, k) / sizeM[k]);
      for (let n = Math.ceil(Math.min(...u)); n <= Math.floor(Math.max(...u)); n++) {
        const pts: number[] = [];
        for (const [x, y] of [[0, 1], [1, 2], [2, 0]]) {
          if ((u[x] - n) * (u[y] - n) > 0 || u[x] === u[y]) continue;
          const t = (n - u[x]) / (u[y] - u[x]), i = [a, b, c][x], j = [a, b, c][y];
          pts.push(p.getX(i) + (p.getX(j) - p.getX(i)) * t, p.getY(i) + (p.getY(j) - p.getY(i)) * t, p.getZ(i) + (p.getZ(j) - p.getZ(i)) * t);
        }
        if (pts.length >= 6) out.push(...pts.slice(0, 6));
      }
    }
  };
  const n = idx ? idx.count : p.count;
  for (let i = 0; i < n; i += 3) idx ? tri(idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)) : tri(i, i + 1, i + 2);
  return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
}
