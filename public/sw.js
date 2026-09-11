self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (evt) => {
  evt.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
  );
  self.clients.claim();
});
self.addEventListener('fetch', (evt) => {
  evt.respondWith(fetch(evt.request));
});
