/**
 * City Roots Farm — Service Worker
 *
 * Estrategia:
 *   - HTML / navegación: NETWORK-FIRST (siempre intenta red; caché solo si offline)
 *   - Otros assets: STALE-WHILE-REVALIDATE (sirve caché rápido, actualiza en background)
 *
 * Resultado: los dispositivos siempre reciben la última versión del HTML en cuanto
 * haya conexión, sin necesidad de hard-refresh manual.
 */

const CACHE_NAME = 'crf-v6';

// Instalación: activar inmediatamente sin esperar que cierren pestañas
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// Activación: limpiar cachés viejos y tomar control de todos los clientes
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Helper: saber si es una request de navegación / documento HTML
function isHtmlRequest(req) {
  if (req.mode === 'navigate') return true;
  if (req.destination === 'document') return true;
  const url = new URL(req.url);
  // Path termina en / o .html
  if (url.pathname.endsWith('/') || url.pathname.endsWith('.html')) return true;
  return false;
}

// Helper: saber si debemos ignorar la request (APIs externas, Apps Script, etc.)
function shouldBypass(req) {
  const url = new URL(req.url);
  // No cachear peticiones a Apps Script / Google
  if (url.hostname.includes('script.google.com')) return true;
  if (url.hostname.includes('googleusercontent.com')) return true;
  // No cachear cross-origin excepto fonts
  if (url.origin !== self.location.origin && !url.hostname.includes('gstatic.com') && !url.hostname.includes('googleapis.com')) {
    return true;
  }
  return false;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Solo GET
  if (req.method !== 'GET') return;

  // Bypass para APIs / cross-origin no-fonts
  if (shouldBypass(req)) return;

  // HTML / navegación → network-first
  if (isHtmlRequest(req)) {
    event.respondWith((async () => {
      try {
        // cache: 'no-store' fuerza al navegador a ir a red
        const networkResponse = await fetch(req, { cache: 'no-store' });
        // Guardar copia para fallback offline
        if (networkResponse && networkResponse.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(req, networkResponse.clone());
        }
        return networkResponse;
      } catch (err) {
        // Offline: servir desde caché
        const cached = await caches.match(req);
        if (cached) return cached;
        // Sin caché y sin red → dejar que el navegador muestre su error
        throw err;
      }
    })());
    return;
  }

  // Assets estáticos (fonts, imágenes) → stale-while-revalidate
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    const networkPromise = fetch(req).then((networkResponse) => {
      if (networkResponse && networkResponse.ok) {
        cache.put(req, networkResponse.clone());
      }
      return networkResponse;
    }).catch(() => cached);
    return cached || networkPromise;
  })());
});

// Permitir que la página pida al SW que haga skipWaiting de inmediato
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
