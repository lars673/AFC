// AFC Service Worker 8.0
// - App-Dateien: Netzwerk zuerst (immer aktuelle Version), Zwischenspeicher nur als Offline-Rückfall.
// - /api/ wird nie zwischengespeichert; die App hält den letzten Plan selbst vor und kennzeichnet ihn als alt.
// - Leaflet (cdnjs) wird zwischengespeichert, damit die Karte nach dem ersten Besuch schneller startet.
const CACHE = 'afc-8.0';
const CORE = ['/', '/app.js', '/app.css', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => e.waitUntil((async () => {
  const c = await caches.open(CACHE);
  // einzeln, damit eine fehlende Datei die Installation nicht verhindert
  await Promise.allSettled(CORE.map(u => c.add(new Request(u, { cache: 'reload' }))));
  await self.skipWaiting();
})()));

self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin === self.location.origin && u.pathname.startsWith('/api/')) return;

  if (u.hostname === 'cdnjs.cloudflare.com' && /leaflet/.test(u.pathname)) {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') (await caches.open(CACHE)).put(req, res.clone());
      return res;
    })());
    return;
  }
  if (u.origin !== self.location.origin) return;

  e.respondWith((async () => {
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
      return res;
    } catch {
      return (await caches.match(req)) || (req.mode === 'navigate' && (await caches.match('/'))) ||
        new Response('AFC offline', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
