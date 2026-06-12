// Service Worker v2 — network-first for pages (always fresh after deploys),
// cache-first for static assets (fast + offline support)
const CACHE = 'daylock-v2';

self.addEventListener('install', (e) => {
  self.skipWaiting(); // activate new SW immediately, don't wait
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // Pages (navigations): NETWORK FIRST — so deploys show up immediately.
  // Falls back to cache only when offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then(c => c || caches.match('/')))
    );
    return;
  }

  // Static assets (JS/CSS/images): cache first, fetch + store if missing
  e.respondWith(
    caches.match(req).then(cached =>
      cached ||
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return res;
      })
    )
  );
});
