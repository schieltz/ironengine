/*
 * IRON ENGINE offline support (self-hosted installs only; registered from index.html).
 * Network first, so updates arrive whenever there's signal; if the network fails or takes longer
 * than TIMEOUT_MS, the phone's saved copy of the app opens instead. Only the app page is cached:
 * training data lives in the app's own storage, never here.
 */
const CACHE = 'ironengine-v1';
const PAGE = './index.html';
const TIMEOUT_MS = 3000;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll([PAGE])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || req.mode !== 'navigate') return;   // only opening the app itself
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await Promise.race([
        fetch(req),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS)),
      ]);
      if (res && res.ok) await cache.put(PAGE, res.clone());
      return res;
    } catch (err) {
      return (await cache.match(PAGE)) || Response.error();
    }
  })());
});
