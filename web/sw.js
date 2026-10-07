// Offline cache for the engine + shell. The player's game file lives in IndexedDB, not here.
// Every shell asset (including the wasm engine) is network-first with a cache fallback, so a half-updated
// shell can never mix an old engine with new loader code — that mismatch hangs the game at its loading bar.
const VERSION = 'bw-v3';                 // bump on every deploy that changes shell or engine files
const ASSETS = ['./', 'index.html', 'app.js', 'app.css', 'manifest.webmanifest', 'vendor/fflate.min.js',
  'runtime/love.js', 'runtime/love.wasm', 'patches/balatro-1.0.1.json', 'patches/web_shim.lua', 'icons/icon-180.png'];

self.addEventListener('install', (e) => e.waitUntil(
  caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())));

self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim())));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;   // never touch the tailnet fetch
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res && res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })));
});
