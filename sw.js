// App shell cache plus cross-origin isolation headers. GitHub Pages cannot
// set COOP/COEP itself; adding them here lets melody extraction use threads.
const VERSION = 'pp-v2';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'pitch.js', 'store.js', 'fft.js', 'extract.js', 'extract-worker.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('pp-v') && k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function isolate(res) {
  if (res.status === 0) return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// Network first so updates show up right away; cache when offline.
// Models are cached by the extraction worker, so they are skipped here.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const cacheable = !req.url.includes('/models/');
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (cacheable && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return isolate(res);
      })
      .catch(() => caches.match(req).then((hit) => (hit ? isolate(hit) : Response.error())))
  );
});
