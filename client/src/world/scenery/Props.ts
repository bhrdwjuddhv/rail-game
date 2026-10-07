import * as THREE from 'three/webgpu';
import { float, instanceIndex, positionLocal, sin, uniform, vec3 } from 'three/tsl';
import { GeoBatch, mat } from '../../core/GeoBatch';
import { canvasTexture, tex } from '../../core/Textures';
import { materials } from '../../core/Materials';
import { renderFlags } from '../../core/Renderer';
import { textures } from '../../core/TextureLibrary';
import { FOOTPRINT, PLINTH_DEPTH, PropType } from './Placement';
import { bakeImpostors, barkTexture, buildTree, grassTuft, grassTexture, leafAtlas, treeSize } from './Vegetation';

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
  const billboard = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 });
  textures.bind(billboard, 'billboard', adAtlas, 1, { resident: true });
  mats = { std: m.std, leaves, bark, grass, impostor, impostorPalm, facade: m.facade, billboard, roof: m.roof, metal: m.metal, brick: m.brick };
  return mats;
}

/** Fictional ads, four in an atlas. */
function adAtlas() {
  return canvasTexture('ads', 512, 256, (g) => {
    const ads = [
      ['#c0392b', '#fff', 'CHAI SUPREME', 'Fresh every morning'],
      ['#1f6f8b', '#fff', 'GANGA CEMENT', 'Strong like a bridge'],
      ['#f1c40f', '#222', 'RAJA MOBILES', '5G phones from Rs 6999'],
      ['#27ae60', '#fff', 'KISAN TRACTORS', 'Built for every field'],
    ];
    ads.forEach(([bg, fg, title, sub], i) => {
      const x = (i % 2) * 256, y = Math.floor(i / 2) * 128;
      g.fillStyle = bg; g.fillRect(x, y, 256, 128);
      g.fillStyle = fg; g.textAlign = 'center';
      g.font = 'bold 34px Arial'; g.fillText(title, x + 128, y + 58);
      g.font = '20px Arial'; g.fillText(sub, x + 128, y + 95);
    });
  }, { repeat: false });
}

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
  const b = new GeoBatch();
  const fp = FOOTPRINT[t];
  // foundation from 15 cm above the base down to PLINTH_DEPTH below it (buildings sit on the highest corner)
  if (fp) b.box(fp[0] * 2 + 0.3, PLINTH_DEPTH + 0.15, fp[1] * 2 + 0.3, mat(0, (0.15 - PLINTH_DEPTH) / 2, 0), t === 'hut' ? '#8a7356' : '#9c968c', t === 'kiln' ? 'brick' : 'std');
  const one = (material: string, shadow = true): Template[] => [{ geometry: b.geometry('std')!, material, shadow }];
  switch (t) {
    case 'mango': case 'neem': case 'palm': case 'forest': case 'bush': {
      // trunk and branches (bark), crown of leaf cards (leaves): see Vegetation
      buildTree(t, b);
      const parts: Template[] = [{ geometry: b.geometry('leaves')!, material: 'leaves', shadow: true }];
      const trunk = b.geometry('bark');
      if (trunk) parts.unshift({ geometry: trunk, material: 'bark', shadow: true });
      return parts;
    }
    case 'hut':
      b.box(4, 2.3, 3.4, mat(0, 1.15, 0), '#9c7a55');
      b.add(new THREE.ConeGeometry(3.4, 2, 4), mat(0, 3.3, 0, Math.PI / 4, 0, 0, 1.2, 1, 1), '#c8a95e');
      b.box(0.9, 1.6, 0.1, mat(0, 0.8, 1.72), '#3a2a1c');
      return one('std');
    case 'house':
      b.box(7, 3.2, 6, mat(0, 1.6, 0), '#ffffff');
      b.box(7.3, 0.5, 6.3, mat(0, 3.45, 0), '#d8d2c8');
      b.box(1.2, 2.1, 0.1, mat(-1.5, 1.05, 3.02), '#5a3a22');
      b.box(1.3, 1.1, 0.1, mat(1.6, 1.8, 3.02), '#2b3540');
      return one('std');
    case 'building2': case 'building4': case 'building7': case 'hospital': case 'school': {
      const floors = t === 'building2' ? 2 : t === 'building4' ? 4 : t === 'building7' ? 7 : t === 'hospital' ? 4 : 2;
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
      if (t !== 'hospital' && t !== 'school') b.box(w * 0.9, 1.1, 0.25, mat(0, 2.4, d / 2 + 0.2), '#c0392b', 'std'); // shop signboard band
      return [
        { geometry: b.geometry('facade')!, material: 'facade', shadow: true },
        { geometry: b.geometry('std')!, material: 'std', shadow: true },
      ];
    }
    case 'tank':
      b.cyl(0.85, 0.85, 1.4, 10, mat(0, 0, 0), '#ffffff');
      return one('std', false);
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
      b.add(new THREE.CylinderGeometry(0, 6.2, 3.5, 4, 1), mat(0, 7.6, 0, Math.PI / 4, 0, 0, 0.92, 1, 1.85), '#7d3b2c');
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
    case 'billboard': {
      for (const s of [-1, 1]) b.cyl(0.12, 0.12, 6, 6, mat(s * 2.5, 3, 0), '#555', 'std');
      const plane = new THREE.BoxGeometry(6.4, 3.2, 0.15);
      const uvA = plane.attributes.uv as THREE.BufferAttribute;
      // pick one atlas quadrant per template variant, set below by cloning
      for (let i = 0; i < uvA.count; i++) uvA.setXY(i, uvA.getX(i) * 0.5, 0.5 + uvA.getY(i) * 0.5);
      b.add(plane, mat(0, 6.5, 0), '#ffffff', 'billboard');
      return [
        { geometry: b.geometry('billboard')!, material: 'billboard', shadow: true },
        { geometry: b.geometry('std')!, material: 'std', shadow: true },
      ];
    }
    case 'quarter':
      b.box(13, 3.2, 7, mat(0, 1.6, 0), '#ffffff');
      b.add(new THREE.CylinderGeometry(0, 5.2, 1.8, 4, 1), mat(0, 4.1, 0, Math.PI / 4, 0, 0, 1.85, 1, 0.98), '#9b4a32');
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
  }
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
