// Offline cache for the engine + shell. The player's game file lives in IndexedDB, not here.
const VERSION = 'bw-v1';
const SHELL = ['./', 'index.html', 'app.js', 'app.css', 'manifest.webmanifest', 'vendor/fflate.min.js',
  'runtime/love.js', 'runtime/love.wasm', 'patches/balatro-1.0.1.json', 'patches/web_shim.lua', 'icons/icon-180.png'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
// Network-first for code/patches (so updates land), cache fallback offline. Cache-first for the big wasm.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.endsWith('.wasm')) {
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request).then((res) => { const c = res.clone(); caches.open(VERSION).then((ca) => ca.put(e.request, c)); return res; })));
    return;
  }
  e.respondWith(fetch(e.request).then((res) => { const c = res.clone(); caches.open(VERSION).then((ca) => ca.put(e.request, c)); return res; })
    .catch(() => caches.match(e.request, { ignoreSearch: true })));
});
