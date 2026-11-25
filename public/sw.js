// Service worker: offline app shell + cached map tiles + notification clicks.
const VERSION = 'ykmaps-v4';
const SHELL = [
  '/',
  '/index.html',
  '/css/app.css',
  '/js/app.js',
  '/js/api.js',
  '/js/core.js',
  '/js/map.js',
  '/js/store.js',
  '/js/ui.js',
  '/js/alarms.js',
  '/js/push.js',
  '/config.js',
  '/css/fonts.css',
  '/fonts/barlow-latin-400-normal.woff2',
  '/fonts/barlow-latin-600-normal.woff2',
  '/fonts/barlow-condensed-latin-800-italic.woff2',
  '/fonts/silkscreen-latin-700-normal.woff2',
  '/fonts/vt323-latin-400-normal.woff2',
  '/js/views/home.js',
  '/js/views/line.js',
  '/js/views/stop.js',
  '/js/views/plan.js',
  '/vendor/leaflet/leaflet.js',
  '/vendor/leaflet/leaflet.css',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
];
const TILE_CACHE = 'ykmaps-tiles';
const MAX_TILES = 1500;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== TILE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function trimTiles() {
  const c = await caches.open(TILE_CACHE);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Map tiles: cache-first.
  if (/basemaps\.cartocdn\.com|tile\.openstreetmap\.org/.test(url.host)) {
    e.respondWith(
      caches.open(TILE_CACHE).then(async (c) => {
        const hit = await c.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok || res.type === 'opaque') {
          c.put(e.request, res.clone());
          if (Math.random() < 0.05) trimTiles();
        }
        return res;
      })
    );
    return;
  }
  if (url.origin !== location.origin) return; // includes the API when it lives on another host

  // API: always network (live data); the page handles failures.
  if (url.pathname.startsWith('/api/')) return;

  // App shell: stale-while-revalidate.
  e.respondWith(
    caches.open(VERSION).then(async (c) => {
      const req = url.pathname === '/' || !url.pathname.includes('.') ? '/index.html' : e.request;
      const hit = await c.match(req);
      const net = fetch(req)
        .then((res) => {
          if (res.ok) c.put(req, res.clone());
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});

// Server-sent notifications (bus alarms, line changes) — arrive even when the app is closed.
self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { title: 'YKMaps', body: e.data && e.data.text() };
  }
  e.waitUntil(
    self.registration.showNotification(d.title || 'YKMaps', {
      body: d.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      tag: d.tag || undefined,
      renotify: !!d.tag,
      vibrate: [300, 150, 300, 150, 600],
      requireInteraction: /yaklaşıyor/.test(d.title || ''),
      data: { url: d.url || '#/' },
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        c.postMessage({ url });
        return c.focus();
      }
      return self.clients.openWindow(`/${url.startsWith('#') ? url : ''}`);
    })
  );
});
