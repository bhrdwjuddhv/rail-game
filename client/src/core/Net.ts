import { ensurePack, packedUrl } from './Packs';

/**
 * The one way the game's own code fetches files by URL (sounds, crowd models, data): a file is never
 * requested twice.
 *  - a file inside a pack (Packs.ts): the pack is fetched once for all its files, the file read from memory;
 *  - in flight: a second request for the same URL shares the first one's promise;
 *  - small files (under 2 MB) stay in memory once loaded (big ones are kept by whoever built from them).
 * Three.js loaders (textures, models) are deduplicated by their users' caches and served from packs by the
 * loading manager's URL modifier.
 */
const inflight = new Map<string, Promise<ArrayBuffer>>();
const memory = new Map<string, ArrayBuffer>();
const SMALL = 2 * 1024 * 1024;

const norm = (url: string) => new URL(url, location.href).href;

/** The file's bytes (from its pack, the memory copy, the request already on its way, or one new request). */
export function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const k = norm(url);
  const m = memory.get(k);
  if (m) return Promise.resolve(m);
  let f = inflight.get(k);
  if (!f) {
    f = ensurePack(k)
      .then(() => fetch(packedUrl(k)))
      .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status} ${url}`))))
      .then(b => { if (b.byteLength < SMALL) memory.set(k, b); return b; })
      .finally(() => inflight.delete(k));
    inflight.set(k, f);
  }
  return f;
}

export async function fetchJson<T = unknown>(url: string): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await fetchBuffer(url))) as T;
}
