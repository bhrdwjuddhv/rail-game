// Rail Bharat service worker: game files cached for repeat visits (and offline play).
//  - content-hashed build files (assets/*-<hash>.js|css|wasm, packs/*): cache first, kept for good
//  - game files under fixed names (textures, models, sounds, pictures): served from the cache at once and
//    refreshed in the background (stale-while-revalidate)
//  - the page: network first (a new build is seen at once), the cached copy when offline
// The build stamps BUILD below (vite.config.ts); a new build starts a new cache and drops the old ones.
const BUILD = '__BUILD__';
const CACHE = `rail-bharat-${BUILD}`;
const HASHED = /\/(assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(js|css|wasm)|packs\/[^/]+)$/;
const GAME = /\/(assets|basis)\//;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('rail-bharat-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // range requests and the dev server's own files are left to the network
  if (req.headers.has('range') || url.pathname.startsWith('/@') || url.pathname.includes('/node_modules/')) return;
  if (HASHED.test(url.pathname)) e.respondWith(cacheFirst(req));
  else if (GAME.test(url.pathname)) e.respondWith(staleWhileRevalidate(req, e));
  else if (req.mode === 'navigate') e.respondWith(networkFirst(req));
});

async function cacheFirst(req) {
  const c = await caches.open(CACHE);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) c.put(req, res.clone());
  return res;
}
async function staleWhileRevalidate(req, e) {
  const c = await caches.open(CACHE);
  const hit = await c.match(req);
  const fresh = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
  if (hit) { e.waitUntil(fresh.then(() => undefined)); return hit; }
  return fresh;
}
async function networkFirst(req) {
  const c = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) c.put(req, res.clone());
    return res;
  } catch {
    return (await c.match(req)) ?? Response.error();
  }
}
