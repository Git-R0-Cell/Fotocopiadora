/* Service worker: guarda la app para que funcione sin conexión tras la primera carga. */
const CACHE = 'escaner-tarjetas-v6';
const CORE = ['./', 'index.html', 'styles.css', 'js/core.js', 'js/app.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-64.png', 'icons/logo-128.png', 'vendor/pdf-lib.min.js'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(CORE);
    // OpenCV se descarga cuando la app lo necesita, no durante la instalación.
    // Así no compite con la primera carga del motor.
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    // red primero para el código de la app (así las actualizaciones llegan), caché si no hay conexión
    const isCode = /\.(html|js|css)$/.test(new URL(req.url).pathname) && !req.url.includes('/vendor/');
    if (hit && !isCode) return hit;
    try {
      const res = await fetch(req);
      if (res && res.ok) {
        event.waitUntil(cache.put(req, res.clone()).catch(() => {}));
      }
      return res;
    } catch (e) {
      if (hit) return hit;
      throw e;
    }
  })());
});
