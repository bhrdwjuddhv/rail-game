// People baker (run by `npm run models`): turns the character GLBs in
// public/assets/models/people/ (Ready Player Me / Mixamo rigs) into small
// crowd files for GPU-instanced, GPU-animated platform crowds.
//
// For each character:
//   1. merge the parts worth drawing (body, head, eyes, hair, glasses, outfit;
//      eyelashes, corneas and teeth are dropped), with each vertex's colour
//      sampled from its texture, and a tint mask on clothing (outfit top = 1,
//      outfit bottom = 2) so every person can wear different colours;
//   2. weld UV seams and simplify to two levels of detail (LOD0 ~2600
//      triangles, LOD1 ~520);
//   3. bake animation into vertex animation textures (VAT): every frame, the
//      skinned position and normal of every vertex. Clips: "idle" (the
//      character's own in-place clip, or another character's, looped with a
//      crossfade) and "walk" (any clip that travels, made in-place; its speed
//      is written so feet do not slide). Clips are retargeted by bone name
//      (all rigs here are Mixamo-compatible). Extra clips dropped into
//      people/anims/<name>.glb (Mixamo, "without skin") are baked too.
//
// Output: public/assets/models/_processed/people/<name>.bin and people.json.
// File: u32 header length, JSON header, then per LOD: indices u16, colours
// u8x4 (rgb + mask), VAT positions f16x4 (rows = frames), VAT normals u8x4.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptSimplifier } from 'meshoptimizer';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(ROOT, 'public/assets/models/people');
const ANIMS = path.join(SRC, 'anims');
const OUT = path.join(ROOT, 'public/assets/models/_processed/people');
const LOD_TRIS = [2600, 520];
const IDLE = { fps: 8, seconds: 4, blend: 0.8 };
const WALK_FRAMES = 16;
const VAT_W = 1024; // VAT texture width: vertices wrap onto further rows (phones cap textures at 4096)
const HEIGHT = { man2: 1.74, teenagerboy: 1.64, woman1: 1.6, woman2: 1.62, porter: 1.7 };
const DROP = /eyelash|cornea|teeth|tongue/i;
const maskOf = name => (/outfit_bottom|bottom|pant|trouser|skirt|jean/i.test(name) ? 2 : /outfit|top|shirt|jacket/i.test(name) && !/shoe/i.test(name) ? 1 : 0);

await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const bone = n => (n ?? '').replace(/^mixamorig\d*:/, '').replace(/_\d+$/, '');

// ------------------------------------------------------------------ small math (column-major 4x4, as glTF)
const mul = (a, b) => { const o = new Float64Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; };
function trs(t, q, s) {
  const [x, y, z, w] = q, [sx, sy, sz] = s;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return Float64Array.of(
    (1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
    2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
    2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1);
}
const xf = (m, x, y, z, w = 1) => [m[0] * x + m[4] * y + m[8] * z + m[12] * w, m[1] * x + m[5] * y + m[9] * z + m[13] * w, m[2] * x + m[6] * y + m[10] * z + m[14] * w];
function slerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const bb = d < 0 ? (d = -d, b.map(v => -v)) : b;
  if (d > 0.9995) { const o = a.map((v, i) => v + (bb[i] - v) * t); const l = Math.hypot(...o); return o.map(v => v / l); }
  const th = Math.acos(d), s = Math.sin(th), wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return a.map((v, i) => v * wa + bb[i] * wb);
}

// ------------------------------------------------------------------ animation clips (by bone name)
/** A clip as tracks by bone name: { duration, tracks: Map(bone -> { rotation?, translation? sampler }), hipsRest, travel } */
async function readClip(doc) {
  const root = doc.getRoot();
  const anim = root.listAnimations()[0];
  if (!anim) return null;
  const tracks = new Map();
  let duration = 0;
  for (const ch of anim.listChannels()) {
    const n = ch.getTargetNode(), p = ch.getTargetPath();
    if (!n || (p !== 'rotation' && p !== 'translation')) continue;
    const s = ch.getSampler(), times = s.getInput().getArray(), vals = s.getOutput().getArray();
    duration = Math.max(duration, times[times.length - 1]);
    const t = tracks.get(bone(n.getName())) ?? {};
    t[p] = { times, vals, size: p === 'rotation' ? 4 : 3, cubic: s.getInterpolation() === 'CUBICSPLINE', step: s.getInterpolation() === 'STEP' };
    tracks.set(bone(n.getName()), t);
  }
  // the clip's own hip height (first frame): some converted rigs carry a meaningless rest translation
  const hipsNode = root.listNodes().find(n => bone(n.getName()) === 'Hips');
  const ht = tracks.get('Hips')?.translation;
  const hipsRest = ht ? sample(ht, 0)[1] : hipsNode ? hipsNode.getTranslation()[1] : 1;
  let travel = 0;
  if (ht) { const v = ht.vals, k = v.length / ht.size; travel = Math.hypot(v[(k - 1) * 3] - v[0], v[(k - 1) * 3 + 2] - v[2]); }
  return { duration, tracks, hipsRest, travel };
}
function sample(tr, time) {
  const { times, vals, size, cubic, step } = tr;
  const at = i => { const o = cubic ? (i * 3 + 1) * size : i * size; return Array.from(vals.subarray(o, o + size)); };
  if (time <= times[0]) return at(0);
  const last = times.length - 1;
  if (time >= times[last]) return at(last);
  let i = 0; while (times[i + 1] < time) i++;
  const k = (time - times[i]) / (times[i + 1] - times[i]);
  if (step) return at(i);
  const a = at(i), b = at(i + 1);
  return size === 4 ? slerp(a, b, k) : a.map((v, j) => v + (b[j] - v) * k);
}

// ------------------------------------------------------------------ one character
async function texturePixels(tex, cache) {
  if (cache.has(tex)) return cache.get(tex);
  const { data, info } = await sharp(Buffer.from(tex.getImage())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = { data, w: info.width, h: info.height };
  cache.set(tex, px);
  return px;
}

async function bakeCharacter(name, file, clips) {
  const doc = await io.read(file);
  const root = doc.getRoot();
  // node hierarchy (parents) and rest pose
  const parent = new Map();
  const walk = (n, p) => { parent.set(n, p); for (const c of n.listChildren()) walk(c, n); };
  for (const sc of root.listScenes()) for (const n of sc.listChildren()) walk(n, null);
  const nodes = [...parent.keys()];

  // ---- merge the visible parts, colour from textures
  const texCache = new Map();
  const V = { pos: [], nrm: [], col: [], mask: [], joints: [], weights: [], skin: [] }, I = [];
  const skins = [];
  for (const node of nodes) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const skin = node.getSkin();
    let si = -1;
    if (skin) { si = skins.indexOf(skin); if (si < 0) { skins.push(skin); si = skins.length - 1; } }
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial(), mname = mat?.getName() ?? mesh.getName();
      if (DROP.test(mname) || DROP.test(mesh.getName())) continue;
      const P = prim.getAttribute('POSITION'), N = prim.getAttribute('NORMAL'), UV = prim.getAttribute('TEXCOORD_0');
      const J = prim.getAttribute('JOINTS_0'), W = prim.getAttribute('WEIGHTS_0');
      const tex = mat?.getBaseColorTexture(), f = mat?.getBaseColorFactor() ?? [1, 1, 1, 1];
      const px = tex ? await texturePixels(tex, texCache) : null;
      const base = V.pos.length / 3, mask = maskOf(mname);
      for (let i = 0; i < P.getCount(); i++) {
        V.pos.push(...P.getElement(i, [0, 0, 0]));
        V.nrm.push(...(N ? N.getElement(i, [0, 0, 0]) : [0, 1, 0]));
        let c = [f[0], f[1], f[2]];
        if (px && UV) {
          const [u, v] = UV.getElement(i, [0, 0]);
          const x = Math.min(px.w - 1, Math.max(0, Math.floor((u - Math.floor(u)) * px.w))), y = Math.min(px.h - 1, Math.max(0, Math.floor((v - Math.floor(v)) * px.h)));
          const o = (y * px.w + x) * 4;
          // sRGB texel -> linear, times the factor (written back as sRGB below)
          c = [0, 1, 2].map(k => Math.pow(px.data[o + k] / 255, 2.2) * f[k]);
        }
        V.col.push(...c.map(v => Math.pow(Math.min(1, v), 1 / 2.2)));
        V.mask.push(mask);
        V.joints.push(...(J ? J.getElement(i, [0, 0, 0, 0]) : [0, 0, 0, 0]));
        V.weights.push(...(W ? W.getElement(i, [0, 0, 0, 0]) : [1, 0, 0, 0]));
        V.skin.push(skin ? si : -1 - nodes.indexOf(node)); // unskinned: rigid on its node
      }
      const idx = prim.getIndices();
      if (idx) for (let i = 0; i < idx.getCount(); i++) I.push(base + idx.getScalar(i));
      else for (let i = 0; i < P.getCount(); i++) I.push(base + i);
    }
  }

  // ---- weld seams: same position + skin -> one vertex (colours averaged)
  const key = new Map(), remap = new Int32Array(V.pos.length / 3), keep = [];
  for (let i = 0; i < remap.length; i++) {
    const k = `${V.skin[i]}|${V.pos.slice(i * 3, i * 3 + 3).map(v => Math.round(v * 1e4)).join(',')}`;
    let j = key.get(k);
    if (j === undefined) { j = keep.length; key.set(k, j); keep.push([i]); } else keep[j].push(i);
    remap[i] = j;
  }
  const nV = keep.length;
  const W = { pos: new Float32Array(nV * 3), nrm: new Float32Array(nV * 3), col: new Float32Array(nV * 3), mask: new Uint8Array(nV), joints: new Uint16Array(nV * 4), weights: new Float32Array(nV * 4), skin: new Int32Array(nV) };
  keep.forEach((list, j) => {
    const i0 = list[0];
    for (let k = 0; k < 3; k++) { W.pos[j * 3 + k] = V.pos[i0 * 3 + k]; W.nrm[j * 3 + k] = V.nrm[i0 * 3 + k]; W.col[j * 3 + k] = list.reduce((a, i) => a + V.col[i * 3 + k], 0) / list.length; }
    for (let k = 0; k < 4; k++) { W.joints[j * 4 + k] = V.joints[i0 * 4 + k]; W.weights[j * 4 + k] = V.weights[i0 * 4 + k]; }
    W.mask[j] = V.mask[i0]; W.skin[j] = V.skin[i0];
  });
  const welded = new Uint32Array(I.map(i => remap[i]));

  // ---- the pose of every node at a clip time (bone-name retargeting), then skinning
  const restT = new Map(nodes.map(n => [n, n.getTranslation()]));
  const hipsNode = nodes.find(n => bone(n.getName()) === 'Hips');
  const own = await readClip(doc);
  // this character's hip height in its own units (its clip's, else the rest pose)
  const myHips = own?.tracks.get('Hips')?.translation ? own.hipsRest : hipsNode ? hipsNode.getTranslation()[1] : 1;
  function worldMatrices(clip, time, inPlace) {
    const local = new Map();
    for (const n of nodes) {
      let t = restT.get(n), q = n.getRotation(), s = n.getScale();
      const tr = clip?.tracks.get(bone(n.getName()));
      if (tr?.rotation) q = sample(tr.rotation, time);
      if (tr?.translation && bone(n.getName()) === 'Hips') {
        const v = sample(tr.translation, time), k = myHips / (clip.hipsRest || 1);
        t = inPlace ? [t[0], v[1] * k, t[2]] : v.map(x => x * k);
      }
      local.set(n, trs(t, q, s));
    }
    const world = new Map();
    const get = n => { if (world.has(n)) return world.get(n); const p = parent.get(n); const m = p ? mul(get(p), local.get(n)) : local.get(n); world.set(n, m); return m; };
    for (const n of nodes) get(n);
    return world;
  }
  function skinFrame(clip, time, inPlace) {
    const world = worldMatrices(clip, time, inPlace);
    const jm = skins.map(sk => {
      const ibm = sk.getInverseBindMatrices()?.getArray();
      return sk.listJoints().map((j, k) => mul(world.get(j), ibm ? Float64Array.from(ibm.subarray(k * 16, k * 16 + 16)) : trs([0, 0, 0], [0, 0, 0, 1], [1, 1, 1])));
    });
    const out = new Float32Array(nV * 6);
    for (let i = 0; i < nV; i++) {
      const x = W.pos[i * 3], y = W.pos[i * 3 + 1], z = W.pos[i * 3 + 2], nx = W.nrm[i * 3], ny = W.nrm[i * 3 + 1], nz = W.nrm[i * 3 + 2];
      let p = [0, 0, 0], q = [0, 0, 0];
      if (W.skin[i] >= 0) {
        for (let k = 0; k < 4; k++) {
          const w = W.weights[i * 4 + k]; if (!w) continue;
          const m = jm[W.skin[i]][W.joints[i * 4 + k]];
          const a = xf(m, x, y, z), b = xf(m, nx, ny, nz, 0);
          for (let c = 0; c < 3; c++) { p[c] += a[c] * w; q[c] += b[c] * w; }
        }
      } else { const m = world.get(nodes[-1 - W.skin[i]]); p = xf(m, x, y, z); q = xf(m, nx, ny, nz, 0); }
      const l = Math.hypot(...q) || 1;
      out.set([...p, q[0] / l, q[1] / l, q[2] / l], i * 6);
    }
    return out;
  }

  // ---- clips: idle (own in-place clip, else another), walk (a travelling clip), extras
  const inPlaceClips = [own, ...clips.people].filter(c => c && c.travel < 0.2 * (c.hipsRest || 1));
  const walking = [own, ...clips.people].filter(c => c && c.travel >= 0.2 * (c.hipsRest || 1));
  const idle = inPlaceClips[0], walkClip = walking[0];
  const frames = [], rows = {};
  const push = (label, list) => { rows[label] = { row: frames.length, frames: list.length }; frames.push(...list); };
  if (idle) {
    const T = Math.min(IDLE.seconds, idle.duration - IDLE.blend), N = Math.round(T * IDLE.fps), D = IDLE.blend;
    const list = [];
    for (let i = 0; i < N; i++) {
      const t = i / IDLE.fps, a = skinFrame(idle, t, true);
      if (t < D) { const b = skinFrame(idle, t + T, true), w = t / D; for (let k = 0; k < a.length; k++) a[k] = b[k] + (a[k] - b[k]) * w; }
      list.push(a);
    }
    push('idle', list);
    rows.idle.fps = IDLE.fps;
  } else { push('idle', [skinFrame(null, 0, true)]); rows.idle.fps = 1; }
  if (walkClip) {
    const list = [];
    for (let i = 0; i < WALK_FRAMES; i++) list.push(skinFrame(walkClip, (i / WALK_FRAMES) * walkClip.duration, true));
    push('walk', list);
    rows.walk.fps = WALK_FRAMES / walkClip.duration;
  }
  for (const [label, c] of clips.extra) {
    const n = Math.max(2, Math.round(c.duration * 10)), list = [];
    for (let i = 0; i < n; i++) list.push(skinFrame(c, (i / n) * c.duration, true));
    push(label, list); rows[label].fps = n / c.duration;
  }

  // ---- normalise: feet on the ground, centred, real height; Mixamo faces +Z
  const f0 = frames[0];
  let minY = Infinity, maxY = -Infinity, cx = 0, cz = 0;
  for (let i = 0; i < nV; i++) { minY = Math.min(minY, f0[i * 6 + 1]); maxY = Math.max(maxY, f0[i * 6 + 1]); cx += f0[i * 6]; cz += f0[i * 6 + 2]; }
  cx /= nV; cz /= nV;
  const height = HEIGHT[name] ?? 1.68, scale = height / (maxY - minY);
  for (const fr of frames) for (let i = 0; i < nV; i++) { fr[i * 6] = (fr[i * 6] - cx) * scale; fr[i * 6 + 1] = (fr[i * 6 + 1] - minY) * scale; fr[i * 6 + 2] = (fr[i * 6 + 2] - cz) * scale; }
  // walking speed (m/s) that matches the stride: source travel per cycle, in this character's metres
  // stride in hip heights (source clip) times this character's hip height, per cycle
  let walkSpeed = 1.3;
  if (walkClip && hipsNode) {
    const hipsY = (worldMatrices(idle, 0, true).get(hipsNode)[13] - minY) * scale;
    walkSpeed = (walkClip.travel / (walkClip.hipsRest || 1)) * hipsY / walkClip.duration;
    if (process.env.DEBUG) console.log(name, { travel: walkClip.travel, hipsRest: walkClip.hipsRest, hipsY, dur: walkClip.duration, walkSpeed });
    if (!(walkSpeed > 0.5 && walkSpeed < 2.2)) walkSpeed = 1.3;
  }

  // ---- LODs: simplify the welded bind-pose mesh, keep the referenced vertices
  const lods = [];
  for (const tris of LOD_TRIS) {
    const target = Math.min(welded.length, tris * 3);
    const count = ix => new Set(ix).size;
    let [idx] = MeshoptSimplifier.simplify(welded, W.pos, 3, target, 0.08, []);
    // many separate strands (hair) keep their vertices: the sloppy simplifier merges them
    // (the sloppy one undershoots: raise its target until it gets close)
    let sl = [];
    for (let t = target - target % 3; t <= welded.length; t = t >= welded.length ? Infinity : Math.min(welded.length, Math.ceil((t * 1.35) / 3) * 3)) { [sl] = MeshoptSimplifier.simplifySloppy(welded, W.pos, 3, null, t, 0.08); if (sl.length >= target * 0.85) break; }
    if (idx.length > target * 1.3 || count(idx) > 1.3 * count(sl)) idx = sl;
    const used = new Map(), order = [];
    const out = new Uint16Array(idx.length);
    for (let k = 0; k < idx.length; k++) { let j = used.get(idx[k]); if (j === undefined) { j = order.length; used.set(idx[k], j); order.push(idx[k]); } out[k] = j; }
    lods.push({ indices: out, verts: order });
  }

  // ---- write
  const half = f16();
  const parts = [], header = { name, height, walkSpeed: +walkSpeed.toFixed(3), clips: rows, frames: frames.length, lods: [] };
  for (const { indices, verts } of lods) {
    const n = verts.length, F = frames.length;
    const RPF = Math.ceil(n / VAT_W); // texture rows per frame
    const VW = Math.ceil(n / RPF);      // row width: as little padding as possible
    const col = new Uint8Array(n * 4), pos = new Uint16Array(VW * RPF * F * 4), nrm = new Uint8Array(VW * RPF * F * 4);
    verts.forEach((v, j) => { for (let k = 0; k < 3; k++) col[j * 4 + k] = Math.round(W.col[v * 3 + k] * 255); col[j * 4 + 3] = W.mask[v] * 127; });
    frames.forEach((fr, f) => verts.forEach((v, j) => {
      const o = ((f * RPF + Math.floor(j / VW)) * VW + (j % VW)) * 4;
      for (let k = 0; k < 3; k++) { pos[o + k] = half(fr[v * 6 + k]); nrm[o + k] = Math.round((fr[v * 6 + 3 + k] * 0.5 + 0.5) * 255); }
      pos[o + 3] = half(1); nrm[o + 3] = 255;
    }));
    header.lods.push({ vertices: n, indices: indices.length, triangles: indices.length / 3, rowsPerFrame: RPF, width: VW });
    parts.push(indices, col, pos, nrm);
  }
  const json = Buffer.from(JSON.stringify(header));
  const pad = b => { const r = b.byteLength % 4; return r ? Buffer.concat([b, Buffer.alloc(4 - r, 0x20)]) : b; };
  const head = pad(json), len = Buffer.alloc(4); len.writeUInt32LE(head.length);
  const body = Buffer.concat(parts.map(p => pad(Buffer.from(p.buffer, p.byteOffset, p.byteLength))));
  const file2 = path.join(OUT, `${name}.bin`);
  fs.writeFileSync(file2, Buffer.concat([len, head, body]));
  return { ...header, bytes: fs.statSync(file2).size, sourceTriangles: Math.round(welded.length / 3) };
}

/** float -> IEEE half bits */
function f16() {
  const f = new Float32Array(1), u = new Uint32Array(f.buffer);
  return v => {
    f[0] = v; const x = u[0], s = (x >>> 16) & 0x8000; let e = ((x >>> 23) & 0xff) - 127 + 15, m = x & 0x7fffff;
    if (e <= 0) return s; if (e >= 31) return s | 0x7c00;
    m = m + 0x1000; if (m & 0x800000) { m = 0; e++; if (e >= 31) return s | 0x7c00; }
    return s | (e << 10) | (m >>> 13);
  };
}

// ------------------------------------------------------------------ main
if (!fs.existsSync(SRC)) { console.log('[people] no people folder: skipped'); process.exit(0); }
const files = fs.readdirSync(SRC).filter(f => f.endsWith('.glb'));
if (!files.length) { console.log('[people] no people models: the simple crowd stays'); process.exit(0); }
fs.mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
// every character's own clip can be shared (bone-name retargeting); extra clips from people/anims
const people = [];
for (const f of files) { const c = await readClip(await io.read(path.join(SRC, f))); if (c) people.push(c); }
const extra = [];
if (fs.existsSync(ANIMS)) for (const f of fs.readdirSync(ANIMS).filter(f => f.endsWith('.glb'))) { const c = await readClip(await io.read(path.join(ANIMS, f))); if (c) extra.push([path.basename(f, '.glb'), c]); }
const manifest = { models: [] };
for (const f of files) {
  const name = path.basename(f, '.glb');
  const r = await bakeCharacter(name, path.join(SRC, f), { people, extra });
  manifest.models.push({ name, file: `${name}.bin`, height: r.height, walkSpeed: r.walkSpeed, clips: r.clips, lods: r.lods, bytes: r.bytes });
  console.log(`[people] ${name}: ${r.sourceTriangles} -> ${r.lods.map(l => l.triangles).join(' / ')} triangles, ${r.frames} frames (${Object.entries(r.clips).map(([k, c]) => `${k} ${c.frames}@${c.fps.toFixed(1)}fps`).join(', ')}), walk ${r.walkSpeed} m/s, ${(r.bytes / 1024).toFixed(0)} KB`);
}
fs.writeFileSync(path.join(OUT, 'people.json'), JSON.stringify(manifest, null, 1));
console.log(`[people] ${manifest.models.length} characters, ${(manifest.models.reduce((a, m) => a + m.bytes, 0) / 1048576).toFixed(2)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
