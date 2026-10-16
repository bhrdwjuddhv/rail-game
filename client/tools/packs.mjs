// npm run packs: bundles the game's files into a few pack files, so a run makes a handful of requests instead
// of hundreds (NETWORK_LOG.md). Writes client/public/packs/<name>.<hash>.pack and src/generated/packs.ts (which
// pack holds which file; bundled into the game, so finding a pack costs no request). Run after `npm run textures`
// and `npm run models` (it packs their output). The single files stay: the dev server and a failed pack use them.
//
// Pack file: "RBPK", uint32 index length (LE), the index as JSON { files: [{ url, offset, length }] } (offsets
// from the end of the index), then the files one after another.
//
// Packs:
//   tex-high / tex-medium   every processed texture at the size that quality uses (KTX2: colour, normal, roughness)
//                           (Low quality draws procedural textures and loads none)
//   model-<id>-<quality>    one loco / coach / cab panel: its three levels of detail for that quality
//   people                  the platform crowd (index + baked characters)
//   sounds                  the station announcements
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const client = path.join(here, '..'), pub = path.join(client, 'public'), out = path.join(pub, 'packs');
const TEX = JSON.parse(fs.readFileSync(path.join(client, '../data/textures.json'), 'utf8'));

/** the size a quality uses (TextureLibrary.pickSize): the largest not over its maxSize, else the smallest */
const pick = (e, q) => {
  const sizes = Object.keys(e.processed.sizes).map(Number).sort((a, b) => b - a);
  const s = sizes.find(v => v <= (e.maxSize[q] ?? e.maxSize.high)) ?? sizes[sizes.length - 1];
  return e.processed.sizes[String(s)];
};

const packs = [];
// (a pack of one file saves nothing: that file stays single)
const add = (name, urls) => { const ok = [...new Set(urls)].filter(u => fs.existsSync(path.join(pub, u))); if (ok.length > 1) packs.push({ name, urls: ok }); };

for (const q of ['high', 'medium']) {
  const urls = [];
  for (const e of Object.values(TEX.textures)) {
    if (!e.processed) continue;
    const s = pick(e, q);
    // the ground shader samples colour only: terrain textures' normal / roughness maps are left out (a tunnel's lining
    // loads its own when needed)
    const terrain = (e.materials ?? []).some(m => m.startsWith('terrain:'));
    for (const k of terrain ? ['colorKtx2'] : ['colorKtx2', 'normalKtx2', 'roughnessKtx2']) if (s[k]) urls.push(`assets/${s[k]}`);
  }
  add(`tex-${q}`, urls);
}
const mdir = path.join(pub, 'assets/models/_processed');
const ids = [...new Set(fs.readdirSync(mdir).filter(f => f.endsWith('.glb')).map(f => f.replace(/\.(high|medium|lod1|lod2)\.glb$/, '')))];
for (const id of ids) for (const [q, near] of [['high', 'high'], ['medium', 'medium'], ['low', 'lod1']]) {
  // (a cab panel is only ever drawn near: its one level)
  add(`model-${id}-${q}`, (id.endsWith('-panel') ? [near] : [near, 'lod1', 'lod2']).map(l => `assets/models/_processed/${id}.${l}.glb`));
}
const pdir = path.join(mdir, 'people');
if (fs.existsSync(pdir)) add('people', fs.readdirSync(pdir).map(f => `assets/models/_processed/people/${f}`));
const adir = path.join(pub, 'assets/announcement');
if (fs.existsSync(adir)) add('sounds', fs.readdirSync(adir).filter(f => /\.(mp3|ogg|wav)$/i.test(f)).map(f => `assets/announcement/${f}`));

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const written = [];
let total = 0;
for (const p of packs) {
  const bufs = p.urls.map(u => fs.readFileSync(path.join(pub, u)));
  let off = 0;
  const files = p.urls.map((url, i) => { const f = { url, offset: off, length: bufs[i].length }; off += bufs[i].length; return f; });
  const index = Buffer.from(JSON.stringify({ files }));
  const head = Buffer.alloc(8);
  head.write('RBPK', 0, 'ascii');
  head.writeUInt32LE(index.length, 4);
  const body = Buffer.concat([head, index, ...bufs]);
  const hash = crypto.createHash('sha1').update(body).digest('hex').slice(0, 10);
  const file = `packs/${p.name}.${hash}.pack`;
  fs.writeFileSync(path.join(pub, file), body);
  written.push({ name: p.name, file, bytes: body.length, urls: p.urls });
  total += body.length;
}
fs.mkdirSync(path.join(client, 'src/generated'), { recursive: true });
fs.writeFileSync(path.join(client, 'src/generated/packs.ts'), `// Written by \`npm run packs\` (tools/packs.mjs): the pack files and the game files each one holds.
export interface PackInfo { name: string; file: string; bytes: number; urls: string[] }
export const PACKS: PackInfo[] = ${JSON.stringify(written, null, 1)};
`);
console.log(`${written.length} packs, ${(total / 1e6).toFixed(1)} MB`);
for (const w of written) console.log(`  ${w.name}: ${w.urls.length} files, ${(w.bytes / 1e6).toFixed(2)} MB`);
