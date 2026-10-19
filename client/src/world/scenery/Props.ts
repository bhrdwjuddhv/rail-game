import * as THREE from 'three/webgpu';
import { float, instanceIndex, positionLocal, sin, uniform, vec3 } from 'three/tsl';
import { GeoBatch, hipRoof, mat } from '../../core/GeoBatch';
import { tex } from '../../core/Textures';
import { materials } from '../../core/Materials';
import { renderFlags } from '../../core/Renderer';
import { textures } from '../../core/TextureLibrary';
import { FOOTPRINT, PLINTH_DEPTH, PropType } from './Placement';
import { bakeImpostors, barkTexture, buildTree, grassTuft, grassTexture, leafAtlas, treeSize } from './Vegetation';
import { buildingTemplate, standInAtlas } from './Buildings';
import { STYLES } from './buildingKit';
import { lifeCells, LifeCell, LifePack } from './lifeKit';
import { canvasTexture, uvToRect } from '../../core/Textures';

/**
 * Vegetation wind. Phases are accumulated on the CPU and wrapped to [0, 2pi)
 * so shader sine inputs stay small and precise forever, and a change in wind
 * strength never makes the phase jump. Bend scales with height above the
 * base, so blades and trunks stay planted.
 */
const TWO_PI = Math.PI * 2;
const glsl = { uWindA: { value: 0 }, uWindB: { value: 0 }, uWind: { value: 0.6 }, uFade: { value: new THREE.Vector2(80, 110) } };
const tsl = { a: uniform(0), b: uniform(0), w: uniform(0.6) };
export const wind = {
  strength: 0.6,
  update(dt: number, strength: number) {
    this.strength = Math.min(2, Math.max(0, strength));
    glsl.uWindA.value = (glsl.uWindA.value + dt * 1.6) % TWO_PI;
    glsl.uWindB.value = (glsl.uWindB.value + dt * 2.3) % TWO_PI;
    glsl.uWind.value = this.strength;
    tsl.a.value = glsl.uWindA.value; tsl.b.value = glsl.uWindB.value; tsl.w.value = this.strength;
  },
  /** grass shrinks into the ground between these camera distances (no popping) */
  setGrassFade(radius: number) { glsl.uFade.value.set(radius * 0.7, Math.max(1, radius)); },
};

/**
 * Classic WebGL: GLSL injected after <begin_vertex>. The spatial phase uses the
 * instance's world position with frequencies that are whole cycles per 500 m,
 * so floating-origin shifts (multiples of 500 m) never change it.
 */
function glslSway(m: THREE.MeshStandardMaterial, amount: number, fade: boolean) {
  m.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, glsl);
    const fadeLine = fade ? 'transformed *= 1.0 - smoothstep(uFade.x, uFade.y, distance(swayOrigin.xyz, cameraPosition));' : '';
    shader.vertexShader = 'uniform float uWindA;\nuniform float uWindB;\nuniform float uWind;\nuniform vec2 uFade;\n' +
      shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
#if defined(USE_BATCHING)
  vec4 swayOrigin = modelMatrix * batchingMatrix * vec4(0.0, 0.0, 0.0, 1.0);
#elif defined(USE_INSTANCING)
  vec4 swayOrigin = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
#else
  vec4 swayOrigin = modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
#endif
  float swayPh = swayOrigin.x * 0.21363 + swayOrigin.z * 0.17593;
  float swayH = max(transformed.y, 0.0);
  transformed.x += sin(uWindA + swayPh) * swayH * ${amount.toFixed(4)} * uWind;
  transformed.z += sin(uWindB + swayOrigin.x * 0.13823 + swayOrigin.z * 0.23876) * swayH * ${(amount * 0.6).toFixed(4)} * uWind;
  ${fadeLine}`);
  };
  m.customProgramCacheKey = () => `sway-${amount}-${fade}`;
  return m;
}

/** WebGPU (TSL) variant: same wind phases; per-instance phase from instanceIndex (stable: placement is deterministic). */
function tslSway(m: THREE.MeshStandardNodeMaterial, amount: number) {
  const phase = instanceIndex.toFloat().mul(0.731);
  const h = positionLocal.y.max(float(0));
  const s1 = sin(tsl.a.add(phase)).mul(h).mul(amount).mul(tsl.w);
  const s2 = sin(tsl.b.add(phase.mul(1.7))).mul(h).mul(amount * 0.6).mul(tsl.w);
  m.positionNode = positionLocal.add(vec3(s1, 0, s2));
  return m;
}

function sway(params: THREE.MeshStandardMaterialParameters, amount: number, fade = false): THREE.Material {
  return renderFlags.classic ? glslSway(new THREE.MeshStandardMaterial(params), amount, fade) : tslSway(new THREE.MeshStandardNodeMaterial(params), amount);
}

let mats: Record<string, THREE.Material> | null = null;
export function propMaterials() {
  if (mats) return mats;
  const m = materials();
  // leaf cards and grass use alpha cut-out (alphaTest), never blending: no sorting flicker
  const leaves = sway({ map: leafAtlas(), alphaTest: 0.45, vertexColors: true, roughness: 0.85 }, 0.012);
  const bark = sway({ map: barkTexture(), vertexColors: true, roughness: 0.95 }, 0.006);
  const grass = sway({ alphaTest: 0.4, roughness: 1 }, 0.12, true);
  textures.bind(grass as THREE.MeshStandardMaterial, 'grass', grassTexture, 1, { resident: true });
  // far trees: impostors baked from the near models (procedural stand-in on WebGPU)
  const baked = bakeImpostors();
  const impostor = sway({ alphaTest: 0.45, side: THREE.DoubleSide, roughness: 1 }, 0.006);
  textures.bind(impostor as THREE.MeshStandardMaterial, 'impostor', () => baked?.broadleaf ?? tex.treeImpostor(), 1, { resident: true });
  const impostorPalm = sway({ alphaTest: 0.45, side: THREE.DoubleSide, roughness: 1, map: baked?.palm ?? tex.treeImpostor() }, 0.006);
  mats = { std: m.std, leaves, bark, grass, impostor, impostorPalm, facade: m.facade, roof: m.roof, metal: m.metal, brick: m.brick, concrete: m.concrete, stone: m.stone, lamp: m.lamp, lamppool: lampPool };
  // festival mode's lights (MeshBasic: they glow; shown by night when the setting is on, see Lighting)
  mats.festive = festiveMaterial;
  // town buildings: each style's facade atlas (cut-out cards; the stand-in atlas until the image loads)
  for (const s of STYLES) {
    const f = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, alphaTest: 0.5 });
    textures.bind(f, `facade-${s}`, () => standInAtlas(s), 1, { resident: true });
    mats[`facade-${s}`] = f;
  }
  // the life packs (data/textures.json: shop fronts, shutters, signboards, wall paintings, goods, awnings / garlands,
  // torans, rangoli, kolam, stencils / clothing fabric): one material each; decals sit on walls and floors (polygon
  // offset), cut-outs by alpha test; a plain white stand-in until the file loads
  const plain = () => canvasTexture('plain-white', 4, 4, (g, w, h) => { g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); }, { repeat: false });
  const life = (key: string, params: THREE.MeshStandardMaterialParameters) => { const mm = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, ...params }); textures.bind(mm, key, plain, 1, { resident: true }); return (mats![key] = mm); };
  life('life-cutout', { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2, side: THREE.DoubleSide });
  // the same cut-outs only up in festival mode (day and night): marigold strings across the houses
  festiveDecals = life('festive-decal', { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2, side: THREE.DoubleSide, visible: false });
  life('life-solid', { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2, side: THREE.DoubleSide }); // (awnings and canopies are seen from below)
  // the same pack lit from inside after dark: open shopfronts and stall boards glow with their own picture
  const lit = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  textures.bind(lit, 'life-lit', plain, 1, { resident: true, glow: 0.55 });
  mats['life-lit'] = lit;
  life('fabric', { roughness: 0.95 });
  life('trim', { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  life('life-vehicle', { roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  mats['festive-sprite'] = festiveSprites;
  // slate roofs in the hills, a stepwell's stone (their tile textures; the procedural roof / stone until then)
  const slate = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
  textures.bind(slate, 'slate', tex.roof, 1, { resident: true });
  mats.slate = slate;
  const sws = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  textures.bind(sws, 'stepwellstone', tex.stone, 1, { resident: true });
  mats.stepwellstone = sws;
  return mats;
}

/** A pack cell as a quad w by h (centred, facing +z) into the batch, placed by m. */
export function cellQuad(b: GeoBatch, key: string, c: LifeCell, w: number, h: number, m: THREE.Matrix4) {
  const [u0, v0, u1, v1] = c.uv;
  b.add(uvToRect(new THREE.PlaneGeometry(w, h), { u0, v0, u1, v1 }), m, '#ffffff', key);
}
/** A box whose every face shows a pack cell (fabric on a figure, goods on a counter). */
function cellBox(b: GeoBatch, key: string, c: LifeCell, w: number, h: number, d: number, m: THREE.Matrix4) {
  const [u0, v0, u1, v1] = c.uv;
  b.add(uvToRect(new THREE.BoxGeometry(w, h, d), { u0, v0, u1, v1 }), m, '#ffffff', key);
}
const cell = (pack: LifePack, name: string, i: number) => { const l = lifeCells(pack, name); return l.length ? l[((i % l.length) + l.length) % l.length] : undefined; };
/** the batch's parts by material, in order (those it has) */
const partsOf = (b: GeoBatch, keys: string[], shadow = true) => keys.flatMap(k => { const g = b.geometry(k); return g ? [{ geometry: g, material: k, shadow }] : []; });

/** festival mode's string lights and diyas (Buildings.festive): hidden unless the setting is on and it is night */
export const festiveMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, visible: false });
/**
 * The pool of light a street lamp throws on the road after dark: a soft warm disc, added to what is under it
 * (Lighting sets its strength; hidden by day).
 */
/** festival mode's daytime decorations (Buildings: marigold strings on the houses); Lighting shows them */
export let festiveDecals: THREE.Material | null = null;
export const lampPool = new THREE.MeshBasicMaterial({
  color: 0xffc98a, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, visible: false,
  polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  map: canvasTexture('lamp-pool', 64, 64, (g, w, h) => {
    const r = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.45, 'rgba(255,255,255,0.45)'); r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, w, h);
  }, { repeat: false }),
});
/** festival mode's sprites from the festival pack (diyas, lanterns): glowing cut-outs, shown with festiveMaterial */
export const festiveSprites = new THREE.MeshBasicMaterial({ vertexColors: true, visible: false, side: THREE.DoubleSide, alphaTest: 0.5 });
textures.bind(festiveSprites as unknown as THREE.MeshStandardMaterial, 'festive-sprite', () => canvasTexture('plain-white', 4, 4, (g, w, h) => { g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); }, { repeat: false }), 1, { resident: true });

interface Template { geometry: THREE.BufferGeometry; material: string; shadow: boolean }
const templates = new Map<PropType, Template[]>();

const crossedQuads = (w: number, h: number) => {
  const a = new THREE.PlaneGeometry(w, h); a.translate(0, h / 2, 0);
  const b = a.clone(); b.rotateY(Math.PI / 2);
  const g = new GeoBatch().add(a, null, '#ffffff', 'x').add(b, null, '#ffffff', 'x');
  return g.geometry('x')!;
};

/** Build geometry for one prop type. Some types have several material parts. */
function build(t: PropType): Template[] {
  if (t.startsWith('bld-')) return buildingTemplate(t);
  const b = new GeoBatch();
  const fp = FOOTPRINT[t];
  // foundation from 15 cm above the base down to PLINTH_DEPTH below it (buildings sit on the highest corner)
  if (fp) b.box(fp[0] * 2 + 0.3, PLINTH_DEPTH + 0.15, fp[1] * 2 + 0.3, mat(0, (0.15 - PLINTH_DEPTH) / 2, 0), t === 'hut' ? '#8a7356' : '#9c968c', t === 'kiln' ? 'brick' : 'std');
  const one = (material: string, shadow = true): Template[] => [{ geometry: b.geometry('std')!, material, shadow }];
  switch (t) {
    case 'mango': case 'neem': case 'palm': case 'forest': case 'bush': case 'pine': {
      // trunk and branches (bark), crown of leaf cards (leaves): see Vegetation
      buildTree(t, b);
      const parts: Template[] = [{ geometry: b.geometry('leaves')!, material: 'leaves', shadow: true }];
      const trunk = b.geometry('bark');
      if (trunk) parts.unshift({ geometry: trunk, material: 'bark', shadow: true });
      return parts;
    }
    case 'hut':
      b.box(4, 2.3, 3.4, mat(0, 1.15, 0), '#9c7a55');
      b.add(hipRoof(4.8, 2, 4.2), mat(0, 3.3, 0), '#c8a95e');
      b.box(0.9, 1.6, 0.1, mat(0, 0.8, 1.72), '#3a2a1c');
      return one('std');
    case 'house':
      b.box(7, 3.2, 6, mat(0, 1.6, 0), '#ffffff');
      b.box(7.3, 0.5, 6.3, mat(0, 3.45, 0), '#d8d2c8');
      b.box(1.2, 2.1, 0.1, mat(-1.5, 1.05, 3.02), '#5a3a22');
      b.box(1.3, 1.1, 0.1, mat(1.6, 1.8, 3.02), '#2b3540');
      return one('std');
    case 'hospital': case 'school': {
      const floors = t === 'hospital' ? 4 : 2;
      const w = t === 'hospital' ? 42 : t === 'school' ? 32 : 12, d = t === 'hospital' ? 14 : t === 'school' ? 11 : 10;
      const h = floors * 3.1;
      const body = new THREE.BoxGeometry(w, h, d);
      // UVs so each 3.1 m floor gets one row of windows (4 per 128px tile => 1 tile per ~13 m)
      const uvA = body.attributes.uv as THREE.BufferAttribute;
      const n = body.attributes.normal as THREE.BufferAttribute;
      for (let i = 0; i < uvA.count; i++) {
        const side = Math.abs(n.getX(i)) > 0.5 ? d : w;
        if (Math.abs(n.getY(i)) > 0.5) { uvA.setXY(i, 0, 0); continue; }
        uvA.setXY(i, uvA.getX(i) * side / 12.4, uvA.getY(i) * floors / 4);
      }
      b.add(body, mat(0, h / 2, 0), '#ffffff', 'facade');
      b.box(w + 0.3, 0.9, d + 0.3, mat(0, h + 0.3, 0), '#d6d0c4', 'std');
      if (t === 'hospital') b.box(4, 4, 0.2, mat(0, h - 2.5, d / 2 + 0.15), '#d63031', 'std');
      return [
        { geometry: b.geometry('facade')!, material: 'facade', shadow: true },
        { geometry: b.geometry('std')!, material: 'std', shadow: true },
      ];
    }
    case 'temple':
      b.box(8, 1, 8, mat(0, 0.5, 0), '#e8dcc4');
      b.box(5, 4, 5, mat(0, 3, 0), '#f3ead8');
      b.add(new THREE.ConeGeometry(3, 9, 8), mat(0, 9.5, 0), '#e9a23b');
      b.box(0.08, 2, 0.08, mat(0, 15, 0), '#555');
      b.box(1.2, 0.7, 0.04, mat(0.6, 15.6, 0), '#ff7f00');
      return one('std');
    case 'mosque':
      b.box(12, 6, 9, mat(0, 3, 0), '#f4f4ef');
      b.add(new THREE.SphereGeometry(3.4, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat(0, 6, 0), '#e8efe6');
      for (const s of [-1, 1]) {
        b.cyl(0.6, 0.7, 14, 8, mat(s * 6.5, 7, -4), '#f4f4ef');
        b.add(new THREE.SphereGeometry(0.9, 8, 6), mat(s * 6.5, 14.3, -4), '#2e8b57');
      }
      return one('std');
    case 'church':
      b.box(8, 6, 16, mat(0, 3, 0), '#efe9dc');
      b.add(hipRoof(8.8, 3.5, 17), mat(0, 7.6, 0), '#7d3b2c');
      b.box(4, 12, 4, mat(0, 6, 9), '#efe9dc');
      b.add(new THREE.ConeGeometry(2.6, 6, 4), mat(0, 15, 9, Math.PI / 4), '#5c6670');
      b.box(0.3, 2.2, 0.3, mat(0, 19, 9), '#444');
      b.box(1.3, 0.3, 0.3, mat(0, 19.4, 9), '#444');
      return one('std');
    case 'kiln':
      b.box(34, 3.2, 20, mat(0, 1.6, 0), '#9c5a3c', 'brick');
      b.cyl(1.1, 1.7, 28, 10, mat(0, 14, 0), '#a8604a', 'brick');
      b.box(30, 0.3, 18, mat(0, 3.3, 0), '#6d5a4a', 'std');
      return [
        { geometry: b.geometry('brick')!, material: 'brick', shadow: true },
        { geometry: b.geometry('std')!, material: 'std', shadow: true },
      ];
    case 'buffalo': case 'cow': {
      const c = t === 'buffalo' ? '#2b2b2b' : '#e9e2d4';
      b.box(2.1, 0.9, 0.85, mat(0, 1.25, 0), c);
      b.box(0.6, 0.55, 0.5, mat(1.25, 1.35, 0, 0, 0, -0.4), c);
      for (const [x, z] of [[0.8, 0.3], [0.8, -0.3], [-0.8, 0.3], [-0.8, -0.3]]) b.box(0.18, 0.85, 0.18, mat(x, 0.42, z), c);
      if (t === 'buffalo') for (const s of [-1, 1]) b.box(0.08, 0.08, 0.45, mat(1.35, 1.7, s * 0.25, 0, s * 0.6), '#cfc6b5');
      return one('std');
    }
    case 'rock':
      b.add(new THREE.DodecahedronGeometry(1, 0), mat(0, 0.5, 0, 0, 0, 0, 1, 0.7, 1), '#ffffff');
      return one('std');
    case 'quarter':
      b.box(13, 3.2, 7, mat(0, 1.6, 0), '#ffffff');
      b.add(hipRoof(13.8, 1.8, 7.6), mat(0, 4.1, 0), '#9b4a32');
      for (const x of [-4, 0, 4]) b.box(1, 2, 0.1, mat(x, 1, 3.52), '#5b3b22');
      return one('std');
    case 'haystack':
      b.add(new THREE.ConeGeometry(1.8, 3.6, 8), mat(0, 1.8, 0), '#cdb36a');
      return one('std');
    case 'tubewell':
      b.box(2.2, 2.2, 2.2, mat(0, 1.1, 0), '#b8775a');
      b.cyl(0.1, 0.1, 1.2, 6, mat(1.4, 0.6, 0, 0, 0, Math.PI / 2), '#555');
      return one('std');
    case 'grass':
      return [{ geometry: grassTuft(), material: 'grass', shadow: false }];
    case 'treeImp': { const s = treeSize('mango'); return [{ geometry: crossedQuads(s.w, s.h), material: 'impostor', shadow: false }]; }
    case 'palmImp': { const s = treeSize('palm'); return [{ geometry: crossedQuads(s.w, s.h), material: 'impostorPalm', shadow: false }]; }
    case 'pineImp':
      // a far pine reads as a dark spire: a 7-sided cone on a stub of trunk
      b.add(new THREE.ConeGeometry(2.7, 11.5, 7), mat(0, 7.2, 0), '#2c4632');
      b.cyl(0.25, 0.3, 1.6, 5, mat(0, 0.8, 0), '#4a3a2c');
      return [{ geometry: b.geometry('std')!, material: 'std', shadow: false }];
    case 'camel': {
      // long legs, humped body, curved neck (tinted per instance)
      const c = '#c49a68';
      b.add(new THREE.SphereGeometry(0.55, 10, 8), mat(0, 1.85, 0, 0, 0, 0, 1.55, 0.75, 0.75), c);
      b.add(new THREE.SphereGeometry(0.38, 8, 6), mat(0.05, 2.3, 0, 0, 0, 0, 1, 0.9, 0.9), c);  // hump
      for (const [x, z] of [[0.6, 0.22], [0.6, -0.22], [-0.6, 0.22], [-0.6, -0.22]]) b.cyl(0.07, 0.06, 1.45, 6, mat(x, 0.72, z), c);
      b.cyl(0.12, 0.15, 0.95, 6, mat(1.05, 2.25, 0, 0, 0, -0.6), c);   // neck
      b.box(0.5, 0.22, 0.22, mat(1.45, 2.62, 0), c);                  // head
      b.cyl(0.03, 0.03, 0.6, 4, mat(-0.88, 1.6, 0, 0, 0, 0.35), '#6b5236');
      // its saddle cloth (the camel-decor fabric: mirrors and tassels), draped either side of the hump
      { const d = cell('life/solid-pack', 'cameldecor', 0); if (d) for (const s of [-1, 1]) cellQuad(b, 'life-solid', d, 1.2, 0.8, mat(0.05, 1.75, s * 0.47, 0, s * 0.25)); }
      return partsOf(b, ['std', 'life-solid']);
    }
    case 'shed':
      // steel goods shed: walls, pitched sheet roof, roller doors
      b.box(18, 6, 12, mat(0, 3, 0), '#c9cdd0');
      b.add(hipRoof(19, 2, 12.6), mat(0, 7, 0), '#7d8a93', 'std');
      for (const x of [-5, 0, 5]) b.box(3.5, 4.2, 0.1, mat(x, 2.1, 6.02), '#5a646b');
      return one('std');
    case 'tiledhouse': {
      // coastal South Indian house: colour-washed walls (tinted per house), green shutters, a front veranda on
      // timber posts, a hipped clay-tile roof coming down over it
      b.box(9, 3.4, 7, mat(0, 1.7, 0), '#ffffff');
      b.box(9.05, 0.6, 7.05, mat(0, 0.3, 0), '#9c6b4e');
      for (const x of [-2.6, 2.6]) b.box(1.1, 1.2, 0.08, mat(x, 1.9, 3.53), '#2f5a3a');
      b.box(1.1, 2.2, 0.08, mat(0, 1.1, 3.53), '#5a3a22');
      b.box(9, 0.25, 2, mat(0, 0.12, 4.5), '#b9b2a6');
      for (const x of [-4, -1.3, 1.3, 4]) b.box(0.18, 2.6, 0.18, mat(x, 1.3, 5.2), '#6e4b33');
      const hip = new THREE.CylinderGeometry(0, 1, 1, 4, 1);
      hip.rotateY(Math.PI / 4); // edges square to the walls
      b.add(hip, mat(0, 4.3, 0.8, 0, 0, 0, 7.6, 1.9, 6.6), '#ffffff', 'roof');
      return [{ geometry: b.geometry('std')!, material: 'std', shadow: true }, { geometry: b.geometry('roof')!, material: 'roof', shadow: true }];
    }
    case 'banana':
      b.cyl(0.13, 0.18, 1.9, 6, mat(0, 0.95, 0), '#7d8a4a');
      for (let i = 0; i < 6; i++) b.box(2.1, 0.03, 0.6, mat(0, 1.85, 0, (i / 6) * Math.PI * 2, 0, -0.45).multiply(mat(1.0, 0, 0)), i % 2 ? '#5f9a35' : '#6fae3e');
      return one('std', false);
    case 'minitower':
      // a small temple-style tower on the skyline (decorative, seen from afar): stepped painted tiers, a vaulted crown
      b.box(10, 5, 7, mat(0, 2.5, 0), '#cfc8bc');
      for (let i = 0; i < 4; i++) b.box(9 - i * 1.8, 2.4, 6 - i * 1.1, mat(0, 6.2 + i * 2.6, 0), i % 2 ? '#bf6a43' : '#d4a24c');
      b.add(new THREE.CylinderGeometry(1.4, 1.4, 3.4, 10, 1, false, 0, Math.PI), mat(0, 15.6, 0, 0, 0, Math.PI / 2), '#bf6a43');
      return one('std');
    case 'warehouse':
      // big logistics warehouse: long low box, blue cladding band, loading bays
      b.box(48, 10, 24, mat(0, 5, 0), '#d9dcde');
      b.box(48.2, 1.6, 24.2, mat(0, 8.2, 0), '#2f5f8f');
      b.box(48.6, 0.4, 24.6, mat(0, 10.2, 0), '#a7adb1');
      for (let x = -20; x <= 20; x += 5) b.box(3.2, 4, 0.12, mat(x, 2.4, 12.03), '#4c555b');
      b.box(48, 1.2, 4, mat(0, 0.6, 14), '#8f8a80');   // loading dock
      return one('std');
    case 'streetlight':
      // a town road's lamp post: tapered pole, an arm over the road, the lamp head
      b.cyl(0.07, 0.11, 7, 6, mat(0, 3.5, 0), '#6f777d', 'metal');
      b.box(1.6, 0.08, 0.08, mat(0.75, 6.9, 0), '#6f777d', 'metal');
      // (the head glows after dark; its light pool on the road below)
      b.box(0.55, 0.14, 0.28, mat(1.45, 6.8, 0), '#ffffff', 'lamp');
      b.add(new THREE.PlaneGeometry(9, 9), mat(1.45, 0.06, 0, 0, -Math.PI / 2), '#ffffff', 'lamppool');
      return [{ geometry: b.geometry('metal')!, material: 'metal', shadow: true }, { geometry: b.geometry('lamp')!, material: 'lamp', shadow: false }, { geometry: b.geometry('lamppool')!, material: 'lamppool', shadow: false }];
    case 'scooter':
      // a parked scooter (body tinted per instance): wheels, floorboard, front apron and handlebar, seat
      for (const x of [-0.55, 0.55]) b.cyl(0.22, 0.22, 0.1, 10, mat(x, 0.22, 0, 0, Math.PI / 2), '#1c1c1c');
      b.box(1.0, 0.1, 0.32, mat(0, 0.35, 0), '#ffffff');
      b.box(0.18, 0.6, 0.36, mat(0.45, 0.65, 0, 0, 0, 0.2), '#ffffff');
      b.box(0.5, 0.35, 0.34, mat(-0.3, 0.55, 0), '#ffffff');
      b.box(0.5, 0.08, 0.3, mat(-0.25, 0.78, 0), '#222222');
      b.box(0.06, 0.06, 0.6, mat(0.52, 1.0, 0), '#333333');
      return one('std', false);
    case 'autorickshaw':
      // three-wheeler: yellow canopy over a green (tinted) body, black front
      b.cyl(0.2, 0.2, 0.12, 10, mat(1.0, 0.2, 0, 0, Math.PI / 2), '#1c1c1c');
      for (const z of [-0.55, 0.55]) b.cyl(0.2, 0.2, 0.12, 10, mat(-0.7, 0.2, z, 0, Math.PI / 2), '#1c1c1c');
      b.box(2.4, 0.5, 1.3, mat(0, 0.6, 0), '#ffffff');
      b.box(0.5, 0.9, 1.0, mat(0.95, 1.1, 0, 0, 0, 0.25), '#222222');
      b.box(2.3, 0.08, 1.35, mat(-0.1, 1.85, 0), '#f2c200');
      for (const [x, z] of [[0.9, 0.6], [0.9, -0.6], [-1.1, 0.6], [-1.1, -0.6]]) b.box(0.05, 1.0, 0.05, mat(x, 1.35, z), '#333333');
      {
        // the body's painted metal (green) and the canopy's (yellow) from the vehicle pack
        const body = cell('life/vehicle-pack', 'auto', 1), top = cell('life/vehicle-pack', 'auto', 0);
        if (body) for (const s of [-1, 1]) cellQuad(b, 'life-vehicle', body, 2.4, 0.5, mat(0, 0.6, s * 0.66, s < 0 ? Math.PI : 0));
        if (top) cellQuad(b, 'life-vehicle', top, 2.3, 1.35, mat(-0.1, 1.9, 0, 0, -Math.PI / 2));
      }
      return partsOf(b, ['std', 'life-vehicle'], false);
    case 'handcart':
      // a vendor's wooden handcart (thela) with a heap of produce (tinted per instance)
      for (const z of [-0.6, 0.6]) b.cyl(0.35, 0.35, 0.08, 12, mat(0, 0.35, z, 0, Math.PI / 2), '#3d3d3d');
      b.box(1.9, 0.12, 1.0, mat(0, 0.8, 0), '#7a5634');
      b.box(1.6, 0.3, 0.8, mat(0, 1.0, 0), '#ffffff');
      for (const s of [-1, 1]) b.box(0.6, 0.05, 0.05, mat(1.15, 0.85, s * 0.35), '#7a5634');
      return one('std', false);
    case 'watertower':
      // a town's overhead water tank: concrete shaft, a wide drum on a flared base, a conical lid
      b.cyl(1.6, 1.8, 18, 12, mat(0, 9, 0), '#cfc8bb', 'concrete');
      b.cyl(4.2, 2.6, 2.2, 16, mat(0, 18.6, 0), '#c6beb0', 'concrete');
      b.cyl(4.4, 4.4, 4.6, 16, mat(0, 22, 0), '#d9d2c4', 'concrete');
      b.add(new THREE.ConeGeometry(4.6, 1.2, 16), mat(0, 24.9, 0), '#bdb5a6', 'concrete');
      return [{ geometry: b.geometry('concrete')!, material: 'concrete', shadow: true }, { geometry: b.geometry('std')!, material: 'std', shadow: true }];
    case 'clocktower': {
      // the town's clock tower (ghanta ghar): a square shaft, a clock on each face, a domed cap
      b.box(4, 1, 4, mat(0, 0.5, 0), '#cbbfa8');
      b.box(3, 14, 3, mat(0, 7, 0), '#e2d6be');
      b.box(3.6, 3.2, 3.6, mat(0, 15.6, 0), '#d8cbb0');
      for (let i = 0; i < 4; i++) b.cyl(1.05, 1.05, 0.08, 20, mat(0, 15.6, 0, (i * Math.PI) / 2).multiply(mat(0, 0, 1.82, 0, Math.PI / 2)), '#f6f2e6');
      b.add(new THREE.SphereGeometry(1.9, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat(0, 17.2, 0), '#c97b4a');
      b.box(0.1, 1.6, 0.1, mat(0, 19.6, 0), '#555555');
      return one('std');
    }
    case 'market': {
      // a market lane: stalls under coloured tarpaulins, produce on the boards
      const tarp = ['#2f6db5', '#d35400', '#c0392b', '#27ae60', '#8e44ad'];
      const goods = ['#e74c3c', '#f39c12', '#27ae60', '#f1c40f', '#d35400', '#95a5a6'];
      for (let i = 0; i < 5; i++) {
        const x = -7.2 + i * 3.6, g = cell('life/solid-pack', 'goods', i * 3 + 1), cover = cell('life/solid-pack', i % 2 ? 'tarpaulin' : 'awning', 0);
        b.box(3, 0.8, 1.6, mat(x, 0.4, 0.6), '#8a6a4a');
        if (g) cellQuad(b, 'life-solid', g, 2.8, 1.4, mat(x, 0.92, 0.6, 0, -Math.PI / 2 + 0.25)); else b.box(2.8, 0.25, 1.4, mat(x, 0.92, 0.6), goods[i % goods.length]);
        for (const z of [-0.6, 1.4]) for (const s of [-1, 1]) b.box(0.06, 2.4, 0.06, mat(x + s * 1.5, 1.2, z), '#555555');
        if (cover) cellQuad(b, 'life-solid', cover, 3.3, 2.6, mat(x, 2.45, 0.4, 0, -Math.PI / 2 - 0.12)); else b.box(3.3, 0.04, 2.6, mat(x, 2.45, 0.4, 0, -0.12), tarp[i % tarp.length]);
      }
      return partsOf(b, ['std', 'life-solid']);
    }
    case 'petrolpump': {
      // a roadside fuel station (fictional brand: colours only): a canopy on four columns, two dispensers, a kiosk, a tall sign
      for (const [x, z] of [[-4, -2.5], [4, -2.5], [-4, 2.5], [4, 2.5]]) b.box(0.4, 5, 0.4, mat(x, 2.5, z), '#e8e8e4');
      b.box(11, 0.7, 8, mat(0, 5.3, 0), '#f4f4f0');
      b.box(11.1, 0.35, 8.1, mat(0, 5.05, 0), '#1f8a4c');
      for (const x of [-2, 2]) { b.box(0.8, 0.2, 2.6, mat(x, 0.1, 0), '#c8c4bc'); b.box(0.6, 1.7, 0.9, mat(x, 1.05, 0), '#f2f2ee'); b.box(0.62, 0.4, 0.92, mat(x, 1.6, 0), '#f39c12'); }
      b.box(5, 3, 4, mat(0, 1.5, -6.5), '#f4f1ea');
      b.box(0.3, 8, 0.3, mat(7.5, 4, 5), '#9aa0a4');
      b.box(2.6, 2.2, 0.3, mat(7.5, 8.6, 5), '#1f8a4c');
      b.box(2.2, 0.6, 0.32, mat(7.5, 8.6, 5), '#f39c12');
      return one('std');
    }
    case 'teastall':
      // a roadside tea stall: a counter under a tarpaulin, the kettle on its stove, glasses in a row, a bench
      b.box(1.8, 1.0, 0.9, mat(0, 0.5, 0), '#8a6a4a');
      for (const [x, z] of [[-0.9, -0.5], [0.9, -0.5], [-0.9, 0.9], [0.9, 0.9]]) b.box(0.05, 2.1, 0.05, mat(x, 1.05, z), '#555555');
      b.box(2.2, 0.03, 1.8, mat(0, 2.1, 0.2, 0, -0.1), '#2e86c1');
      b.cyl(0.18, 0.2, 0.25, 10, mat(-0.5, 1.15, 0), '#3d3d3d');
      b.cyl(0.13, 0.16, 0.25, 10, mat(-0.5, 1.4, 0), '#c0c4c8');
      for (let i = 0; i < 6; i++) b.cyl(0.03, 0.025, 0.08, 6, mat(0.1 + i * 0.1, 1.05, 0.25), '#e8d7b0');
      b.box(1.6, 0.08, 0.35, mat(0, 0.42, 1.5), '#6b4a2e');
      {
        const sign = cell('life/solid-pack', 'signboards', 0), back = cell('life/solid-pack', 'goods', 1);
        if (sign) cellQuad(b, 'life-lit', sign, 1.8, 1.8 / sign.aspect, mat(0, 2.25, 0.95));
        if (back) cellQuad(b, 'life-solid', back, 1.7, 1.0, mat(0, 1.55, -0.48));
      }
      return partsOf(b, ['std', 'life-solid', 'life-lit'], false);
    case 'rickshaw':
      // a cycle rickshaw: the rider's bicycle front, a seat for two under a folding hood (tinted)
      b.cyl(0.33, 0.33, 0.04, 12, mat(1.0, 0.33, 0, 0, Math.PI / 2), '#1c1c1c');
      for (const z of [-0.5, 0.5]) b.cyl(0.33, 0.33, 0.04, 12, mat(-0.6, 0.33, z, 0, Math.PI / 2), '#1c1c1c');
      b.box(1.6, 0.06, 0.06, mat(0.2, 0.6, 0), '#2c3e50');
      b.box(0.8, 0.12, 1.1, mat(-0.6, 0.85, 0), '#7b241c');
      b.box(0.1, 0.6, 1.1, mat(-0.95, 1.15, 0), '#7b241c');
      {
        const c = cell('life/vehicle-pack', 'rickshaw', 0), hood = new THREE.CylinderGeometry(0.6, 0.6, 1.1, 10, 1, true, 0, Math.PI);
        if (c) b.add(uvToRect(hood, { u0: c.uv[0], v0: c.uv[1], u1: c.uv[2], v1: c.uv[3] }), mat(-0.6, 1.3, 0, 0, Math.PI / 2, 0), '#ffffff', 'life-vehicle');
        else b.add(hood, mat(-0.6, 1.3, 0, 0, Math.PI / 2, 0), '#ffffff');
      }
      return partsOf(b, ['std', 'life-vehicle'], false);
    case 'dog':
      // a stray dog, lying or standing about (tinted coat)
      b.box(0.7, 0.3, 0.25, mat(0, 0.45, 0), '#ffffff');
      b.box(0.22, 0.22, 0.2, mat(0.42, 0.6, 0), '#ffffff');
      b.box(0.15, 0.08, 0.1, mat(0.58, 0.57, 0), '#ffffff');
      for (const [x, z] of [[0.25, 0.09], [0.25, -0.09], [-0.25, 0.09], [-0.25, -0.09]]) b.box(0.06, 0.32, 0.06, mat(x, 0.16, z), '#ffffff');
      b.box(0.3, 0.05, 0.05, mat(-0.45, 0.55, 0, 0, 0, 0.6), '#ffffff');
      return one('std', false);
    case 'tanker':
      // a water tanker trailer: a blue drum on two wheels, the tap at the back
      b.cyl(0.75, 0.75, 3.2, 12, mat(0, 1.25, 0, 0, 0, Math.PI / 2), '#2471a3');
      for (const z of [-0.85, 0.85]) b.cyl(0.42, 0.42, 0.2, 10, mat(0, 0.42, z, 0, Math.PI / 2), '#1c1c1c');
      b.box(1.4, 0.08, 0.08, mat(2.2, 0.8, 0), '#3d3d3d');
      return one('std', false);
    case 'cylindercart':
      // a handcart stacked with red gas cylinders (delivery)
      for (const z of [-0.55, 0.55]) b.cyl(0.32, 0.32, 0.06, 10, mat(0, 0.32, z, 0, Math.PI / 2), '#1c1c1c');
      b.box(1.6, 0.08, 0.95, mat(0, 0.66, 0), '#6b4a2e');
      for (let i = 0; i < 6; i++) b.cyl(0.16, 0.16, 0.6, 10, mat(-0.55 + (i % 3) * 0.55, 1.0, i < 3 ? -0.22 : 0.22), '#c0392b');
      return one('std', false);
    case 'wallad': {
      // a hand-painted wall advertisement on a village wall: a coloured panel, a band and a round device (no words)
      b.box(9, 2.6, 0.35, mat(0, 1.3, 0), '#e9dcc4');
      b.box(7, 1.9, 0.02, mat(0, 1.4, 0.19), '#c0392b');
      b.box(6.6, 0.45, 0.025, mat(0, 0.75, 0.2), '#f4f4f0');
      b.cyl(0.6, 0.6, 0.03, 16, mat(-2.4, 1.7, 0.2, 0, Math.PI / 2), '#f1c40f');
      for (let i = 0; i < 3; i++) b.box(2.8 - i * 0.6, 0.18, 0.025, mat(0.8, 1.95 - i * 0.35, 0.2), '#f4f4f0');
      return one('std');
    }
    case 'streetwire':
      // the tangle of wires along a town road from pole to pole (scaled along x to the gap): power, phone, cable
      for (const [y, z, k] of [[6.8, 0.3, 0], [6.5, 0.5, 1], [6.2, 0.1, 2], [6.0, 0.6, 3], [5.7, 0.4, 4]] as const) b.box(1, 0.03, 0.03, mat(0.5, y, z, 0, 0, (k - 2) * 0.004), '#222222');
      return one('std', false);
    case 'shop0': case 'shop1': case 'shop2': case 'shop3': case 'shop4': case 'shop5': case 'shop6': case 'shop7': {
      // a one-room shop by the road: its front from the shopfront pack (6, 7: shutters down, a board above), an
      // awning on some (an empty shell if the pack is missing)
      const k = +t.slice(4), shut = k >= 6;
      b.box(3.6, 3.4, 3.0, mat(0, 1.7, -0.05), '#d8cdb8');
      b.box(3.8, 0.25, 3.2, mat(0, 3.5, -0.05), '#a49d93');
      const front = shut ? cell('life/solid-pack', 'shutters', k * 5 + 1) : cell('life/solid-pack', 'shopfronts', k * 3 + 1);
      if (front) {
        const h = shut ? 2.6 : Math.min(3.3, 3.4 / front.aspect);
        cellQuad(b, shut ? 'life-solid' : 'life-lit', front, shut ? 3.2 : 3.4, h, mat(0, h / 2 + 0.05, 1.47));
        const sign = shut ? cell('life/solid-pack', 'signboards', k * 7 + 3) : undefined;
        if (sign) cellQuad(b, 'life-solid', sign, 3.2, 3.2 / sign.aspect, mat(0, 2.65 + 1.6 / sign.aspect, 1.47));
        const aw = k % 2 === 0 ? cell('life/solid-pack', 'awning', 0) : undefined;
        if (aw) cellQuad(b, 'life-solid', aw, 3.8, 1.5, mat(0, 3.0, 2.1, 0, -Math.PI / 2 + 0.5));
      } else b.box(3.2, 2.6, 0.05, mat(0, 1.35, 1.47), '#5a646b');
      return partsOf(b, ['std', 'life-solid', 'life-lit']);
    }
    case 'wallpaint0': case 'wallpaint1': case 'wallpaint2': case 'wallpaint3': case 'wallpaint4': case 'wallpaint5': case 'wallpaint6': case 'wallpaint7': {
      // a village wall with a painting on it (elephant, peacock, a train, a tractor... from the pack)
      const k = +t.slice(9);
      b.box(7, 2.8, 0.35, mat(0, 1.4, 0), '#e9dcc4');
      const p = cell('life/solid-pack', 'paintings', k * 2 + (k > 3 ? 1 : 0));
      if (p) cellQuad(b, 'life-solid', p, 2.4 * Math.min(1.4, p.aspect), 2.4, mat(0, 1.45, 0.18));
      return partsOf(b, ['std', 'life-solid']);
    }
    case 'tyreshop': {
      // a truck repair shop: a tin roof on steel posts over a concrete floor, a low brick back wall, tyres stacked
      // high, oil drums, a workbench with a vice, a compressor
      b.box(8.6, 0.12, 5.6, mat(0, 0.06, 0), '#a7a196');
      for (const [x, z] of [[-4, -2.6], [4, -2.6], [-4, 2.6], [4, 2.6]]) b.box(0.15, 3.6, 0.15, mat(x, 1.8, z), '#5d646b', 'metal');
      b.box(9, 0.08, 6.2, mat(0, 3.7, 0.2, 0, 0.12), '#8d9399', 'metal');
      b.box(8.4, 1.4, 0.25, mat(0, 0.7, -2.7), '#a0634a');
      for (const [x, z, n] of [[-3.2, -1.8, 6], [-2.1, -1.9, 4], [3.3, -1.5, 5]] as const) for (let k = 0; k < n; k++) b.cyl(0.52, 0.52, 0.3, 14, mat(x, 0.27 + k * 0.31, z), '#1d1d1d');
      for (const [x, c] of [[1.4, '#1f4e9c'], [2.0, '#c0392b']] as const) b.cyl(0.3, 0.3, 0.9, 10, mat(x, 0.57, -2.0), c, 'metal');
      b.box(2, 0.9, 0.7, mat(-0.4, 0.57, -2.1), '#6b4a2e');
      b.box(0.9, 0.7, 0.5, mat(3.4, 0.47, 1.7), '#c0392b', 'metal');
      return [{ geometry: b.geometry('std')!, material: 'std', shadow: true }, { geometry: b.geometry('metal')!, material: 'metal', shadow: true }];
    }
    case 'warntriangle':
      // a broken-down truck's warning triangle (red, white inside) on its little stand
      for (const [x, y, rz] of [[-0.19, 0.33, -0.5], [0.19, 0.33, 0.5], [0, 0.08, Math.PI / 2]] as const) b.box(0.05, 0.48, 0.03, mat(x, y + 0.05, 0, 0, 0, rz), '#d61f1f');
      b.box(0.5, 0.03, 0.2, mat(0, 0.015, 0), '#333333');
      return one('std', false);
    case 'branches':
      // leafy branches laid on the road behind a broken-down truck (the Indian warning)
      for (let i = 0; i < 4; i++) {
        b.cyl(0.04, 0.06, 2.2, 5, mat(-1 + i * 0.6, 0.06, (i % 2) * 0.4, 0.3 * i, 0, Math.PI / 2), '#5b4330');
        b.add(new THREE.IcosahedronGeometry(0.35, 0), mat(-1.7 + i * 0.6, 0.25, (i % 2) * 0.4), '#3d6b2f');
      }
      return one('std', false);
    case 'stringlights':
      // a dhaba's strings of bulbs across its front (the bulbs glow at night: the lamp material)
      for (let i = 0; i < 4; i++) b.cyl(0.015, 0.015, 3, 3, mat(-4.5 + i * 3, 3.0 - Math.sin(Math.PI * 0.5) * 0.2, 0, 0, 0, Math.PI / 2), '#333333');
      for (let i = 0; i < 24; i++) { const x = -6 + i * 0.5, y = 3.05 - 0.25 * Math.sin(((i % 6) / 6) * Math.PI); b.box(0.09, 0.11, 0.09, mat(x, y, 0), ['#ffd27a', '#ff8a5c', '#9dffb0', '#7ab8ff'][i % 4], 'lamp'); }
      return [{ geometry: b.geometry('std')!, material: 'std', shadow: false }, { geometry: b.geometry('lamp')!, material: 'lamp', shadow: false }];
    case 'chabutra':
      // the raised round platform (chabutra) round a village's big tree: plastered brick, a step
      b.cyl(3.2, 3.4, 0.7, 20, mat(0, 0.35, 0), '#cfc3ad');
      b.cyl(3.5, 3.6, 0.25, 20, mat(0, 0.12, 0), '#b9ad98');
      return one('std');
    case 'handpump':
      b.box(1.2, 0.15, 1.2, mat(0, 0.07, 0), '#9c968c');
      b.cyl(0.09, 0.11, 1.1, 8, mat(0, 0.65, 0), '#2f6b3a', 'metal');
      b.cyl(0.05, 0.05, 0.35, 6, mat(0.18, 0.95, 0, 0, 0, Math.PI / 2), '#2f6b3a', 'metal');
      b.box(0.8, 0.05, 0.05, mat(-0.35, 1.25, 0, 0, 0, -0.35), '#2f6b3a', 'metal');
      return [{ geometry: b.geometry('std')!, material: 'std', shadow: true }, { geometry: b.geometry('metal')!, material: 'metal', shadow: true }];
    case 'chaupal':
      // the village chaupal (where the elders sit): a raised plinth, four brick posts, a sloping tin roof, a bench
      // and a notice board (no religious or political marks)
      b.box(4.2, 0.45, 3.4, mat(0, 0.22, 0), '#cfc2a8');
      for (const [x, z] of [[-1.85, -1.45], [1.85, -1.45], [-1.85, 1.45], [1.85, 1.45]]) b.box(0.3, 2.3, 0.3, mat(x, 1.6, z), '#a0634a');
      b.box(4.6, 0.08, 3.9, mat(0, 2.85, 0, 0, 0.1), '#8d9399');
      b.box(3.0, 0.42, 0.5, mat(0, 0.66, -1.1), '#7b5a3c');
      b.box(1.1, 0.75, 0.05, mat(1.2, 1.6, 1.6), '#2f4a3a');
      return one('std');
    case 'charpai':
      // a woven cot (charpai): wooden frame on four legs, a rope bed (tinted)
      for (const [x, z] of [[-0.9, -0.42], [0.9, -0.42], [-0.9, 0.42], [0.9, 0.42]]) b.box(0.08, 0.45, 0.08, mat(x, 0.22, z), '#6b4a2e');
      b.box(1.95, 0.08, 0.95, mat(0, 0.45, 0), '#d8c49a');
      return one('std', false);
    case 'clothesline':
      for (const x of [-2, 2]) b.box(0.06, 1.9, 0.06, mat(x, 0.95, 0), '#5a4a3a');
      b.box(4, 0.02, 0.02, mat(0, 1.85, 0), '#333333');
      [['#c0392b', -1.4], ['#f1c40f', -0.7], ['#2980b9', 0], ['#e67e22', 0.7], ['#8e44ad', 1.4]].forEach(([c, x], i) => {
        // clothes cut out of the clothesline atlas (a sari, a kurta, a dhoti...) hung on the line, else fabric squares
        const cl = cell('life/cutout-pack', 'clothes', i * 3 + 1);
        if (cl) { cellQuad(b, 'life-cutout', cl, 0.8 * cl.aspect, 0.8, mat(x as number, 1.42, 0)); return; }
        const f = cell('life/fabric-pack', i % 2 ? 'menswear' : 'saree', i * 5 + 2);
        if (f) cellBox(b, 'fabric', f, 0.55, 0.8, 0.02, mat(x as number, 1.4, 0)); else b.box(0.55, 0.8, 0.02, mat(x as number, 1.4, 0), c as string);
      });
      return partsOf(b, ['std', 'fabric', 'life-cutout'], false);
    case 'dungcakes':
      // a mud wall with cow-dung cakes stuck on to dry
      b.box(8, 1.6, 0.35, mat(0, 0.8, 0), '#a68a68');
      for (let i = 0; i < 18; i++) b.cyl(0.18, 0.18, 0.05, 8, mat(-3.6 + (i % 9) * 0.9, 0.5 + Math.floor(i / 9) * 0.6, 0.2, 0, Math.PI / 2), '#5b4a36');
      return one('std');
    case 'tractor':
      // a tractor (tinted body) with a trolley of hay behind
      b.box(2.2, 1.0, 1.1, mat(0.6, 1.2, 0), '#ffffff');
      b.box(0.9, 0.9, 1.0, mat(-0.4, 1.9, 0), '#ffffff');
      for (const z of [-0.85, 0.85]) { b.cyl(0.75, 0.75, 0.35, 12, mat(-0.4, 0.75, z, 0, Math.PI / 2), '#1c1c1c'); b.cyl(0.4, 0.4, 0.25, 10, mat(1.4, 0.4, z, 0, Math.PI / 2), '#1c1c1c'); }
      b.box(3.6, 1.3, 2.1, mat(-3.4, 1.3, 0), '#d8b864');
      for (const z of [-1, 1]) b.cyl(0.45, 0.45, 0.25, 10, mat(-3.4, 0.45, z, 0, Math.PI / 2), '#1c1c1c');
      return one('std');
    case 'bund':
      // a raised field edge (30 m), grass on it
      b.box(30, 0.35, 0.9, mat(0, 0.1, 0), '#7a8a4a');
      return one('std', false);
    case 'scarecrow':
      b.box(0.08, 2.2, 0.08, mat(0, 1.1, 0), '#6b4a2e');
      b.box(1.4, 0.08, 0.08, mat(0, 1.7, 0), '#6b4a2e');
      b.box(0.6, 0.8, 0.3, mat(0, 1.5, 0), '#c0392b');
      b.add(new THREE.SphereGeometry(0.2, 8, 6), mat(0, 2.15, 0), '#e8dcc0');
      b.add(new THREE.ConeGeometry(0.35, 0.3, 8), mat(0, 2.4, 0), '#c8a95e');
      return one('std', false);
    case 'person0': case 'person1': case 'person2': case 'person3': case 'person4': case 'person5':
    case 'person6': case 'person7': case 'person8': case 'person9': case 'person10': case 'person11': {
      // a figure in everyday clothes cut from the fabric pack: 0-3 a sari, 4-7 a shirt and trousers, 8-11 a kurta and
      // turban (each variant its own cloth; tinted a little per person)
      const k = +t.slice(6), skin = '#8d5a3c', hair = '#1a1a1a';
      if (lifeCells('life/fabric-pack', 'saree').length) {
        if (k < 4) {
          const sari = cell('life/fabric-pack', 'saree', k * 5 + 2)!, blouse = cell('life/fabric-pack', 'saree', k * 5 + 9)!;
          b.add(uvToRect(new THREE.CylinderGeometry(0.17, 0.27, 0.95, 10), { u0: sari.uv[0], v0: sari.uv[1], u1: sari.uv[2], v1: sari.uv[3] }), mat(0, 0.48, 0), '#ffffff', 'fabric');
          cellBox(b, 'fabric', blouse, 0.38, 0.5, 0.24, mat(0, 1.2, 0));
          cellBox(b, 'fabric', sari, 0.16, 0.75, 0.27, mat(0.12, 1.15, 0, 0, 0, -0.35));   // the pallu over the shoulder
          for (const s of [-1, 1]) b.box(0.08, 0.5, 0.08, mat(s * 0.24, 1.12, 0), skin);
        } else {
          const top = cell('life/fabric-pack', 'menswear', k * 3)!, bottom = cell('life/fabric-pack', 'menswear', k * 3 + 7)!;
          for (const s of [-1, 1]) cellBox(b, 'fabric', bottom, 0.15, 0.85, 0.2, mat(s * 0.09, 0.43, 0));
          cellBox(b, 'fabric', top, 0.42, k >= 8 ? 0.85 : 0.6, 0.26, mat(0, k >= 8 ? 1.05 : 1.15, 0));
          for (const s of [-1, 1]) cellBox(b, 'fabric', top, 0.09, 0.55, 0.09, mat(s * 0.26, 1.12, 0));
          if (k >= 8) { const tb = cell('life/fabric-pack', 'turban', k * 4 + 1) ?? top; b.add(uvToRect(new THREE.SphereGeometry(0.17, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), { u0: tb.uv[0], v0: tb.uv[1], u1: tb.uv[2], v1: tb.uv[3] }), mat(0, 1.66, 0, 0, 0, 0, 1, 0.9, 1), '#ffffff', 'fabric'); }
        }
        b.add(new THREE.SphereGeometry(0.13, 8, 6), mat(0, 1.6, 0), skin);
        if (k < 8) b.add(new THREE.SphereGeometry(0.14, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), mat(0, 1.64, 0), hair);
        return partsOf(b, ['std', 'fabric'], false);
      }
      const look = [['#c0392b', '#c0392b', '#1a1a1a'], ['#f4f1ea', '#f4f1ea', '#e67e22'], ['#2471a3', '#3d3d3d', '#1a1a1a'], ['#f4f1ea', '#1b4f72', '#1a1a1a']][k % 4];
      b.box(0.34, 0.85, 0.24, mat(0, 0.43, 0), look[1]);
      b.box(0.42, 0.6, 0.26, mat(0, 1.15, 0), look[0]);
      b.add(new THREE.SphereGeometry(0.13, 8, 6), mat(0, 1.6, 0), '#8d5a3c');
      b.add(new THREE.SphereGeometry(0.14, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), mat(0, 1.64, 0), look[2]);
      for (const s of [-1, 1]) b.box(0.09, 0.55, 0.09, mat(s * 0.26, 1.12, 0), look[0]);
      return one('std', false);
    }
    case 'bullockcart':
      // a bullock cart: two bullocks yoked to a wooden cart on spoked wheels
      for (const z of [-0.45, 0.45]) {
        b.box(1.8, 0.8, 0.6, mat(2.4, 1.2, z), '#e9e2d4');
        for (const x of [1.8, 3.0]) b.box(0.15, 0.85, 0.15, mat(x, 0.42, z), '#e9e2d4');
        b.box(0.45, 0.45, 0.4, mat(3.45, 1.45, z), '#e9e2d4');
      }
      b.box(2.4, 0.15, 1.4, mat(-0.4, 1.1, 0), '#8a6a4a');
      b.box(2.6, 0.08, 0.08, mat(1.0, 1.05, 0), '#6b4a2e');
      for (const z of [-0.75, 0.75]) b.cyl(0.65, 0.65, 0.1, 12, mat(-0.4, 0.65, z, 0, Math.PI / 2), '#6b4a2e');
      return one('std', false);
    case 'bricks':
      // a stack of fresh bricks, the kiln's (tinted brick red)
      for (let i = 0; i < 3; i++) b.box(4, 1.1, 1.3, mat(0, 0.55 + i * 1.1, 0).multiply(mat(i * 0.15, 0, 0)), '#ffffff', 'brick');
      return [{ geometry: b.geometry('brick')!, material: 'brick', shadow: true }];
    case 'dhaba': {
      // a highway dhaba: a long open hall under a tin roof on posts, a counter and the clay tandoor out front
      b.box(10, 0.3, 7, mat(0, 0.15, 0), '#9c968c');
      for (const [x, z] of [[-4.8, -3.3], [0, -3.3], [4.8, -3.3], [-4.8, 3.3], [4.8, 3.3]]) b.box(0.2, 3, 0.2, mat(x, 1.6, z), '#5a4a3a');
      b.box(10.6, 0.1, 7.6, mat(0, 3.15, 0, 0, 0.06), '#8d9599');
      b.box(10, 2.6, 0.25, mat(0, 1.45, 3.3), '#e9d6b0');
      b.box(3, 1, 0.8, mat(-2, 0.8, -1), '#c0392b');
      b.cyl(0.55, 0.7, 1.0, 12, mat(3.2, 0.8, -4.2), '#a0522d');
      b.box(4, 1, 0.1, mat(0, 3.7, -3.6), '#f39c12');
      { const tp = cell('life/solid-pack', 'tarpaulin', 0); if (tp) cellQuad(b, 'life-solid', tp, 10.6, 7.6, mat(0, 3.22, 0, 0, -Math.PI / 2 + 0.06)); }
      return partsOf(b, ['std', 'life-solid']);
    }
    case 'truckpainted': {
      // a goods truck painted the Indian way: a coloured body (tinted), the cab's bright front and a painted
      // tailboard, a horn-please panel (pattern only), tassels
      b.box(2.2, 2.3, 2.4, mat(3.0, 1.55, 0), '#f39c12');
      b.box(2.25, 0.5, 2.45, mat(3.0, 2.85, 0), '#c0392b');
      b.box(5.8, 0.45, 2.5, mat(-1.0, 1.0, 0), '#3d3d3d');
      b.box(5.6, 1.9, 2.45, mat(-1.0, 2.15, 0), '#ffffff');
      b.box(0.05, 1.7, 2.3, mat(-3.82, 2.15, 0), '#2e86c1');
      b.box(0.06, 0.4, 2.0, mat(-3.84, 2.4, 0), '#f1c40f');
      b.box(0.06, 0.25, 2.0, mat(-3.84, 1.7, 0), '#c0392b');
      for (const x of [2.9, -2.1, -3.1]) for (const z of [-1.1, 1.1]) b.cyl(0.5, 0.5, 0.35, 12, mat(x, 0.5, z, 0, Math.PI / 2), '#1c1c1c');
      {
        // the vehicle pack: painted body sides and the decorated tailboard (peacocks, a lotus, a sunrise...)
        const side = cell('life/vehicle-pack', 'trucksides', 1), art = cell('life/vehicle-pack', 'truckart', 0);
        if (side) for (const s of [-1, 1]) cellQuad(b, 'life-vehicle', side, 5.6, 1.9, mat(-1.0, 2.15, s * 1.235, s < 0 ? Math.PI : 0));
        if (art) cellQuad(b, 'life-vehicle', art, 2.3, 1.9, mat(-3.86, 2.15, 0, -Math.PI / 2));
      }
      return partsOf(b, ['std', 'life-vehicle']);
    }
    case 'milestone':
      // a highway milestone: yellow top over white
      b.box(0.5, 0.6, 0.18, mat(0, 0.3, 0), '#f4f4f0');
      b.add(new THREE.CylinderGeometry(0.25, 0.25, 0.18, 12, 1, false, 0, Math.PI), mat(0, 0.6, 0, Math.PI / 2, Math.PI / 2), '#f1c40f');
      return one('std', false);
    case 'paintedtrunk':
      // a roadside tree, its trunk painted white and red (for the headlights)
      b.cyl(0.25, 0.3, 1.2, 8, mat(0, 0.6, 0), '#f4f4f0');
      b.cyl(0.26, 0.26, 0.25, 8, mat(0, 1.0, 0), '#c0392b');
      b.cyl(0.22, 0.26, 3, 8, mat(0, 2.7, 0), '#6b5340');
      b.add(new THREE.SphereGeometry(2.4, 8, 6), mat(0, 5.2, 0, 0, 0, 0, 1, 0.8, 1), '#4c7a35');
      return one('std');
    case 'pylon': {
      // a high-tension lattice tower, 30 m: four legs tapering in, cross arms, X bracing
      const leg = (x: number, z: number) => { const L = Math.hypot(30, 2.6); b.box(0.25, L, 0.25, mat(x * 1.3, 15, z * 1.3, 0, -z * 0.087, x * 0.087), '#9aa1a6', 'metal'); };
      for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) leg(x, z);
      for (let y = 4; y < 28; y += 4) { const w = 5.2 - (y / 30) * 2.6; b.box(w, 0.12, 0.12, mat(0, y, w / 2), '#9aa1a6', 'metal'); b.box(w, 0.12, 0.12, mat(0, y, -w / 2), '#9aa1a6', 'metal'); }
      for (const y of [22, 26.5]) b.box(0.4, 0.4, 12, mat(0, y, 0), '#9aa1a6', 'metal');
      return [{ geometry: b.geometry('metal')!, material: 'metal', shadow: true }];
    }
    case 'wirespan':
      // the conductors from one tower to the next (scaled along x to the span), at the cross arms' ends
      for (const [y, z] of [[22, -5.8], [22, 5.8], [26.5, -5.8], [26.5, 5.8], [29.5, 0]]) b.box(1, 0.05, 0.05, mat(0.5, y - 0.6, z), '#3d3d3d', 'metal');
      return [{ geometry: b.geometry('metal')!, material: 'metal', shadow: false }];
    case 'mobiletower':
      // a mobile phone mast: a lattice tower, its antennas and dishes, a little equipment cabin at its foot
      b.cyl(0.5, 1.4, 34, 3, mat(0, 17, 0), '#b8bec2', 'metal');
      for (let i = 0; i < 3; i++) b.box(0.3, 2.2, 0.15, mat(0, 32, 0, (i * Math.PI * 2) / 3).multiply(mat(0, 0, 0.9)), '#f4f4f0', 'metal');
      b.cyl(0.4, 0.4, 0.1, 10, mat(0, 27, 0.8, 0, Math.PI / 2), '#f4f4f0', 'metal');
      b.box(3, 2.6, 2.4, mat(3, 1.3, 0), '#d9d2c4', 'metal');
      return [{ geometry: b.geometry('metal')!, material: 'metal', shadow: true }];
    case 'factory':
      // a small factory: a long shed, an office block, a brick chimney
      b.box(24, 8, 14, mat(0, 4, 0), '#c9c4ba');
      b.box(24.4, 0.4, 14.4, mat(0, 8.2, 0, 0, 0.05), '#8d9599');
      b.box(8, 6, 6, mat(-8, 3, 9), '#e9e2d4');
      b.cyl(0.9, 1.3, 24, 10, mat(9, 12, -4), '#a8604a', 'brick');
      for (let x = -9; x <= 9; x += 6) b.box(4, 4, 0.1, mat(x, 2.2, 7.05), '#5a646b');
      return [{ geometry: b.geometry('std')!, material: 'std', shadow: true }, { geometry: b.geometry('brick')!, material: 'brick', shadow: true }];
    case 'goalpost':
      for (const z of [-1.8, 1.8]) b.box(0.08, 2.2, 0.08, mat(0, 1.1, z), '#f4f4f0');
      b.box(0.08, 0.08, 3.6, mat(0, 2.2, 0), '#f4f4f0');
      return one('std', false);
    case 'stumps':
      for (const z of [-0.1, 0, 0.1]) b.box(0.03, 0.7, 0.03, mat(0, 0.35, z), '#e9d6b0');
      return one('std', false);
    case 'goat':
      // a goat (tinted coat): body, neck and head, thin legs, little horns
      b.box(0.9, 0.45, 0.32, mat(0, 0.75, 0), '#ffffff');
      b.box(0.25, 0.35, 0.2, mat(0.5, 1.0, 0, 0, 0, -0.5), '#ffffff');
      for (const [x, z] of [[0.35, 0.12], [0.35, -0.12], [-0.35, 0.12], [-0.35, -0.12]]) b.box(0.07, 0.55, 0.07, mat(x, 0.28, z), '#ffffff');
      for (const z of [-0.06, 0.06]) b.box(0.04, 0.16, 0.04, mat(0.58, 1.25, z, 0, 0, 0.5), '#3d3d3d');
      return one('std', false);
    case 'cyclist':
      // a cyclist on a mud track (shirt tinted)
      for (const x of [-0.55, 0.55]) b.cyl(0.33, 0.33, 0.04, 14, mat(x, 0.33, 0, 0, Math.PI / 2), '#1c1c1c');
      b.box(1.1, 0.05, 0.05, mat(0, 0.6, 0, 0, 0, 0.15), '#2c3e50');
      b.box(0.3, 0.65, 0.3, mat(-0.1, 1.25, 0, 0, 0, -0.25), '#ffffff');
      b.box(0.14, 0.6, 0.14, mat(-0.05, 0.75, 0), '#3d3d3d');
      b.add(new THREE.SphereGeometry(0.12, 8, 6), mat(0.05, 1.7, 0), '#8d5a3c');
      return one('std', false);
    case 'solarpanel':
      // a row of solar panels on a frame, tilted to the south
      b.box(16, 0.08, 3, mat(0, 1.4, 0, 0, 0.45), '#1e2c4a', 'metal');
      for (let x = -7; x <= 7; x += 3.5) b.box(0.08, 1.4, 0.08, mat(x, 0.7, 0), '#9aa1a6', 'metal');
      return [{ geometry: b.geometry('metal')!, material: 'metal', shadow: true }];
    case 'fortwall':
      // a stretch of an old fort's wall: sandstone, crenellated, a bastion (scaled taller or lower per piece)
      b.box(14, 7, 2.5, mat(0, 3.5, 0), '#c49a68', 'stone');
      for (let x = -6; x <= 6; x += 2) b.box(1, 1, 2.5, mat(x, 7.5, 0), '#c49a68', 'stone');
      b.cyl(3, 3.4, 9, 12, mat(7, 4.5, 0), '#b88e5e', 'stone');
      return [{ geometry: b.geometry('stone')!, material: 'stone', shadow: true }];
    case 'chhatri':
      // a chhatri: a dome on four pillars on a stepped plinth (sandstone)
      b.box(4.6, 0.8, 4.6, mat(0, 0.4, 0), '#c9a06c', 'stone');
      for (const [x, z] of [[-1.5, -1.5], [1.5, -1.5], [-1.5, 1.5], [1.5, 1.5]]) b.box(0.4, 3, 0.4, mat(x, 2.3, z), '#d4ac78', 'stone');
      b.box(4, 0.4, 4, mat(0, 3.9, 0), '#c9a06c', 'stone');
      b.add(new THREE.SphereGeometry(1.9, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat(0, 4.1, 0), '#d4ac78', 'stone');
      return [{ geometry: b.geometry('stone')!, material: 'stone', shadow: true }];
    case 'stepwell':
      // a stepwell's head: a walled square with steps going down inside (seen as stepped tiers) and a pavilion
      b.box(12, 1.2, 0.8, mat(0, 0.6, -6), '#c49a68', 'stepwellstone');
      b.box(12, 1.2, 0.8, mat(0, 0.6, 6), '#c49a68', 'stepwellstone');
      b.box(0.8, 1.2, 12, mat(-6, 0.6, 0), '#c49a68', 'stepwellstone');
      for (let i = 0; i < 5; i++) b.box(10 - i * 1.6, 0.25, 10 - i * 1.6, mat(0, -0.1 - i * 0.25, 0), '#b88e5e', 'stepwellstone');
      b.add(new THREE.CylinderGeometry(0, 1, 1, 4, 1), mat(6, 3.2, 0, Math.PI / 4, 0, 0, 2.6, 1.2, 2.6), '#c49a68', 'stepwellstone');
      for (const [x, z] of [[4.8, -1.2], [4.8, 1.2], [7.2, -1.2], [7.2, 1.2]]) b.box(0.3, 2.4, 0.3, mat(x, 1.2 + 0.6, z), '#d4ac78', 'stepwellstone');
      return [{ geometry: b.geometry('stepwellstone')!, material: 'stepwellstone', shadow: true }];
    case 'terrace':
      // a dry stone terrace wall along the contour (60 m), the field behind it
      b.box(12, 1.4, 0.6, mat(0, 0.7, 0), '#8f8a84', 'stone');
      b.box(12, 0.1, 9, mat(0, 1.4, -4.8), '#7a8a4a');
      return [{ geometry: b.geometry('stone')!, material: 'stone', shadow: true }, { geometry: b.geometry('std')!, material: 'std', shadow: false }];
    case 'teabush':
      // a row of clipped tea bushes (10 m)
      for (let i = 0; i < 6; i++) b.add(new THREE.SphereGeometry(0.75, 8, 6), mat(-4.2 + i * 1.7, 0.6, 0, 0, 0, 0, 1.1, 0.75, 1), i % 2 ? '#3f6b2f' : '#4c7a35');
      return one('std', false);
    case 'woodstack':
      // firewood stacked against a house wall under a lean-to (the hills' winter store)
      for (let i = 0; i < 4; i++) for (let j = 0; j < 8; j++) b.cyl(0.12, 0.12, 1.2, 6, mat(-1.6 + j * 0.45, 0.13 + i * 0.25, 0, 0, Math.PI / 2), '#8a6a4a');
      b.box(4.2, 0.08, 1.6, mat(0, 1.4, 0, 0, 0.25), '#5f5a55');
      return one('std');
    case 'saltheap':
      b.add(new THREE.ConeGeometry(2.2, 1.6, 12), mat(0, 0.8, 0), '#f6f6f2');
      b.box(5.5, 0.08, 5.5, mat(0, 0.04, 0), '#cfd4d6');
      return one('std', false);
    case 'turbine': {
      // 3-blade wind turbine, ~80 m hub height (rotation = yaw into the wind)
      b.cyl(1.2, 2.2, 80, 12, mat(0, 40, 0), '#eceeee');
      b.box(9, 3.6, 3.4, mat(1.5, 81.5, 0), '#e4e6e6');
      b.add(new THREE.SphereGeometry(1.4, 10, 8), mat(-3.2, 81.5, 0), '#e4e6e6');
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + 0.3;
        b.box(0.5, 38, 2.2, mat(-3.6, 81.5, 0).multiply(new THREE.Matrix4().makeRotationX(a)).multiply(mat(0, 19.5, 0)), '#f2f3f3');
      }
      return one('std');
    }
  }
  throw new Error(`no template for prop "${t}"`);
}

export function propTemplate(t: PropType) {
  let tp = templates.get(t);
  if (!tp) {
    tp = build(t);
    for (const p of tp) { p.geometry.computeBoundingSphere(); }
    templates.set(t, tp);
  }
  return tp;
}
