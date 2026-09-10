const CACHE_NAME = 'patchwork-cache-v1';
const STATIC_ASSETS = [
  '/',
  '/admin',
  '/manifest.json'
];

self.addEventListener('install', (evt) => {
  evt.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (evt) => {
  evt.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (evt) => {
  // Let network handle API requests directly
  if (evt.request.url.includes('/api/')) {
    return;
  }
  evt.respondWith(
    fetch(evt.request).catch(() => caches.match(evt.request))
  );
});
