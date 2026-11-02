// AFC Service Worker 8.0
// - App-Dateien: Netzwerk zuerst (immer aktuelle Version), Zwischenspeicher nur als Offline-Rückfall.
// - /api/ wird nie zwischengespeichert; die App hält den letzten Plan selbst vor und kennzeichnet ihn als alt.
// - Leaflet liegt im Projekt (/vendor/leaflet) und gehört zu den App-Dateien.
const CACHE = 'afc-8.7';
const CORE = ['/', '/app.js', '/pilot.js', '/route.js', '/airspace.js', '/logbook.js', '/igc.js', '/app.css', '/manifest.json', '/icon-192.png', '/icon-512.png', '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css'];

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

  if (u.origin !== self.location.origin) return;

  e.respondWith((async () => {
    // Schlechter Empfang am Startplatz: nach 4 s die gespeicherte Version zeigen, im Hintergrund weiter laden
    const net = fetch(req, { cache: 'no-cache' }).then(async res => { if (res.ok) await (await caches.open(CACHE)).put(req, res.clone()); return res; });
    net.catch(() => {});
    const cached = () => caches.match(req).then(hit => hit || (req.mode === 'navigate' ? caches.match('/') : null));
    const slow = new Promise(r => setTimeout(r, 4000)).then(cached);
    try {
      const first = await Promise.race([net, slow]);
      if (first) return first;
      return await net;
    } catch {
      return (await cached()) || new Response('AFC offline', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});

// Benachrichtigungen vom eigenen Mac (Web Push, siehe lib/webpush.js)
self.addEventListener('push', e => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(m.title || 'AFC', { body: m.body || '', tag: m.tag || undefined, icon: '/icon-192.png', badge: '/icon-192.png', data: { url: m.url || '/' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil((async () => {
    for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
      if ('focus' in c) { c.postMessage({ type: 'open', url }); return c.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});
