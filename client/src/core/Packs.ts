import * as THREE from 'three/webgpu';
import { settings } from './Settings';

interface PackInfo { name: string; file: string; bytes: number; urls: string[] }
// the pack list written by `npm run packs` (src/generated, not in git): none until it has been run
const GEN = import.meta.glob<{ PACKS: PackInfo[] }>('../generated/packs.ts', { eager: true });
const PACKS: PackInfo[] = Object.values(GEN)[0]?.PACKS ?? [];

/**
 * Pack files (tools/packs.mjs, `npm run packs`): many game files in one request. Before a file is loaded,
 * ensurePack(url) fetches the pack that holds it (once, for every file in it); the files then come from memory:
 * three.js loaders through the loading manager's URL modifier (each file a blob: URL), our own fetches through
 * Net. The built game only: the dev server, and a pack that fails, use the single files as before.
 */
const BASE = import.meta.env.BASE_URL;
const abs = (u: string) => new URL(u, location.href).href;
/** packs holding each file (by absolute URL) */
const holders = new Map<string, PackInfo[]>();
const loads = new Map<string, Promise<void>>();
/** a packed file's in-memory copy */
const blobs = new Map<string, string>();
let on = false;

/** Start using packs (the built game, once `npm run packs` has written them). */
export function initPacks() {
  if (!import.meta.env.PROD || !PACKS.length || on) return;
  on = true;
  for (const p of PACKS) for (const u of p.urls) {
    const k = abs(BASE + u);
    (holders.get(k) ?? holders.set(k, []).get(k)!).push(p);
  }
  THREE.DefaultLoadingManager.setURLModifier(url => blobs.get(abs(url)) ?? url);
}

/** the current quality's pack among those holding a file (textures: high or medium; models: high, medium or low) */
function packFor(url: string) {
  const ps = holders.get(abs(url));
  if (!ps?.length) return null;
  const quality = settings.get().quality;
  const tq = quality === 'medium' ? 'medium' : 'high', mq = quality === 'low' ? 'low' : quality === 'medium' ? 'medium' : 'high';
  return ps.find(p => p.name === `tex-${tq}` || p.name.endsWith(`-${mq}`)) ?? ps[0];
}

/** The pack holding this file is loaded (or there is none / it failed: the single file is used). */
export function ensurePack(url: string): Promise<void> {
  if (!on || blobs.has(abs(url))) return Promise.resolve();
  const p = packFor(url);
  if (!p) return Promise.resolve();
  let l = loads.get(p.name);
  if (!l) {
    l = fetch(BASE + p.file).then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`)))).then(buf => {
      const v = new DataView(buf);
      if (new TextDecoder().decode(new Uint8Array(buf, 0, 4)) !== 'RBPK') throw new Error('not a pack');
      const n = v.getUint32(4, true), start = 8 + n;
      const index = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, n))) as { files: { url: string; offset: number; length: number }[] };
      for (const f of index.files) {
        const k = abs(BASE + f.url);
        if (!blobs.has(k)) blobs.set(k, URL.createObjectURL(new Blob([new Uint8Array(buf, start + f.offset, f.length)])));
      }
    }).catch(e => { console.warn(`[packs] ${p.file} not loaded - the single files are used`, e); });
    loads.set(p.name, l);
  }
  return l;
}

/** a packed file's in-memory URL (blob:), or the URL itself */
export const packedUrl = (url: string) => blobs.get(abs(url)) ?? url;
