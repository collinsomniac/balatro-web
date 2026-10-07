/* Balatro Web: bring-your-own-game loader + full-screen shell for love.js (LÖVE 11.5, single-threaded).
 * The player's game file is stored ONLY in their browser (IndexedDB). It is patched at every launch
 * from patches/*.json + web_shim.lua, so patch updates apply automatically without re-picking the file. */
(() => {
'use strict';
const $ = (id) => document.getElementById(id);
const isDev = ['127.0.0.1', 'localhost'].includes(location.hostname);
// dev tabs share one command queue; tag each launch so the agent can target this tab
const TAG = window.BW_TAG = new URLSearchParams(location.search).get('tag') || (isDev ? 'tab' + Math.random().toString(36).slice(2, 6) : '');
const status = (t) => { $('status').textContent = t || ''; if (t) log('status: ' + t); };
const log = (...a) => (window.__send ? window.__send(a.join(' ')) : console.log(...a));
const prefs = {
  get quality() { return parseFloat(localStorage.getItem('bw.quality') || '2'); },
  set quality(v) { localStorage.setItem('bw.quality', String(v)); },
  get perf() { return localStorage.getItem('bw.perf') === '1'; },
  set perf(v) { localStorage.setItem('bw.perf', v ? '1' : '0'); },
};

/* ---------- tiny IndexedDB key/value store ---------- */
const idb = (() => {
  let dbp;
  const db = () => dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('balatro-web', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const tx = async (mode, fn) => { const d = await db(); return new Promise((res, rej) => {
    const t = d.transaction('kv', mode); const s = t.objectStore('kv'); const r = fn(s);
    t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); }); };
  return { get: (k) => tx('readonly', (s) => s.get(k)), set: (k, v) => tx('readwrite', (s) => s.put(v, k)), del: (k) => tx('readwrite', (s) => s.delete(k)) };
})();

/* ---------- game file: locate the zip inside Balatro.exe (fused LÖVE exe) ---------- */
function extractZip(u8) {
  // End-of-central-directory record: last 22..65557 bytes.
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      const cdSize = dv.getUint32(i + 12, true), cdOff = dv.getUint32(i + 16, true);
      const start = i - cdSize - cdOff;            // where the zip begins inside the exe
      if (start >= 0) return u8.subarray(start);
    }
  }
  throw new Error('No game archive found in that file. Pick Balatro.exe (Windows/Steam) or a game.love.');
}

async function importFile(file) {
  status(`Reading ${file.name} (${(file.size / 1e6).toFixed(1)} MB)…`);
  const u8 = new Uint8Array(await file.arrayBuffer());
  const zip = extractZip(u8);
  const files = fflate.unzipSync(zip, { filter: (f) => f.name === 'version.jkr' });
  const ver = new TextDecoder().decode(files['version.jkr'] || new Uint8Array()).split('\n')[0] || 'unknown';
  await idb.set('game', zip.slice());           // copy: drop the exe header bytes
  await idb.set('game.meta', { name: file.name, size: zip.length, version: ver, added: Date.now() });
  status('');
  return ver;
}

/* ---------- patching (exact-match, fail loudly) ---------- */
async function loadPatchSet() {
  const [set, shim] = await Promise.all([
    fetch('patches/balatro-1.0.1.json', { cache: 'no-cache' }).then((r) => r.json()),
    fetch('patches/web_shim.lua', { cache: 'no-cache' }).then((r) => r.text()),
  ]);
  return { set, shim };
}
function applyPatches(files, { set, shim }) {
  const dec = new TextDecoder(), enc = new TextEncoder();
  const ver = dec.decode(files['version.jkr'] || new Uint8Array()).split('\n')[0];
  if (!ver.startsWith(set.game_version_prefix)) log(`warning: game ${ver}, patches target ${set.game_version_prefix}x`);
  const texts = {};
  for (const p of set.patches) {
    if (!files[p.file]) throw new Error(`Patch "${p.label}": ${p.file} missing (game ${ver})`);
    let s = texts[p.file] ?? dec.decode(files[p.file]);
    const n = s.split(p.find).length - 1;
    if (n !== 1) throw new Error(`Patch "${p.label}" failed in ${p.file}: ${n} matches (game ${ver}). This game version isn't supported yet.`);
    texts[p.file] = s.replace(p.find, () => p.replace);
  }
  for (const [f, s] of Object.entries(texts)) files[f] = enc.encode(s);
  files['web_shim.lua'] = enc.encode(shim);
  return ver;
}

/* ---------- display: full-screen canvas, quality = render scale ---------- */
let quality = prefs.quality;
try { Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => quality }); } catch (e) { log('dpr override failed ' + e); }
function fitCanvas() {
  const portrait = innerHeight > innerWidth;
  $('rotate').classList.toggle('hidden', !(document.body.classList.contains('running') && portrait));
}
addEventListener('resize', fitCanvas);
addEventListener('orientationchange', () => setTimeout(fitCanvas, 300));
const standalone = matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || navigator.standalone;
if (!standalone && /iPhone|iPad|Mac/.test(navigator.platform + navigator.userAgent)) $('install').classList.remove('hidden');

/* ---------- audio: WebKit keeps contexts suspended until a gesture; resume all of them on every tap ---------- */
const audioCtxs = [];
for (const name of ['AudioContext', 'webkitAudioContext']) {
  const AC = window[name]; if (!AC) continue;
  window[name] = class extends AC { constructor(...a) { super(...a); audioCtxs.push(this); } };
}
const resumeAudio = () => audioCtxs.forEach((c) => c.state !== 'running' && c.resume().catch(() => {}));
['pointerdown', 'touchend', 'keydown'].forEach((e) => addEventListener(e, resumeAudio, { capture: true, passive: true }));
document.addEventListener('visibilitychange', () => { if (!document.hidden) resumeAudio(); });

/* ---------- perf overlay ---------- */
let rafFrames = 0, lastPerf = {};
(function raf() { rafFrames++; requestAnimationFrame(raf); })();
setInterval(() => {
  if (prefs.perf && document.body.classList.contains('running')) {
    const p = lastPerf; const c = $('canvas');
    $('perf').textContent = `page ${rafFrames}fps  lua ${p.fps ?? '-'}fps  slow ${p.long ?? 0}  worst ${p.worst_ms ?? 0}ms\n${c.width}×${c.height} @${quality}x  lua ${((p.mem_kb || 0) / 1024).toFixed(0)}MB`;
  }
  rafFrames = 0;
}, 1000);

/* ---------- Lua <-> JS bridge ---------- */
const Bridge = window.BalatroBridge = {
  handlers: {},
  on(kind, fn) { (this.handlers[kind] ||= []).push(fn); },
  // JS -> Lua: arrives in web_shim as love.handlers.web
  send(cmd, data) { const M = window.LoveState; if (M && M.love_send_event) M.love_send_event('web', JSON.stringify({ c: cmd, d: data ?? null }), 0); },
  fromLua(line) {
    const sp = line.indexOf(' '); const kind = sp < 0 ? line : line.slice(0, sp); const payload = sp < 0 ? '' : line.slice(sp + 1);
    if (kind === 'boot') { sendViewport(); }
    else if (kind === 'viewport') log('viewport ' + payload);
    if (kind === 'perf') { try { lastPerf = JSON.parse(payload); } catch {} if (isDev) log('perf ' + payload); }
    else if (kind === 'sync') flushSaves('lua');
    else if (kind === 'shot') { if (isDev) fetch('/__shot', { method: 'POST', body: 'data:image/png;base64,' + payload }).then(() => log('shot ok ' + payload.length)); }
    else if (kind === 'error') { console.error('LUA ERROR ' + payload); status('Game error — see console'); }
    else log('lua ' + kind + ' ' + payload);
    (this.handlers[kind] || []).forEach((fn) => fn(payload));
  },
};
function sendViewport() {
  if (!window.LoveState || !window.LoveState.love_send_event) return;
  Bridge.send('viewport', { w: Math.round(innerWidth), h: Math.round(innerHeight), dpr: quality });
}
let vpT;
addEventListener('resize', () => { clearTimeout(vpT); vpT = setTimeout(() => { sendViewport(); fitCanvas(); }, 250); });
addEventListener('orientationchange', () => setTimeout(() => { sendViewport(); fitCanvas(); }, 400));
function flushSaves(why) {
  const FS = window.LoveState && window.LoveState.FS; if (!FS) return;
  try { FS.syncfs(false, (e) => e && log('syncfs ' + why + ' ' + e)); } catch (e) { log('flush error ' + e); }
}
addEventListener('pagehide', () => flushSaves('pagehide'));
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSaves('hidden'); });

/* ---------- launch ---------- */
async function play() {
  const zip = await idb.get('game');
  if (!zip) return showStep();
  quality = parseFloat($('quality').value); prefs.quality = quality;
  status('Patching…');
  const t0 = performance.now();
  const files = fflate.unzipSync(zip);
  let ver;
  try { ver = applyPatches(files, await loadPatchSet()); }
  catch (e) { status(e.message); return; }
  log(`patched ${ver} in ${Math.round(performance.now() - t0)}ms`);
  status('Starting…');
  try { navigator.wakeLock && (window.__wake = await navigator.wakeLock.request('screen')); } catch {}
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch {}
  document.body.classList.add('running'); fitCanvas();

  const canvas = $('canvas');
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); status('Graphics reset by iOS — reload to continue'); document.body.classList.remove('running'); }, false);
  window.LoveState = {
    arguments: [], canvas,
    print: (...a) => { const t = a.join(' '); if (t.startsWith('__WEB__:')) Bridge.fromLua(t.slice(8)); else if (isDev) log('lua: ' + t); },
    printErr: (...a) => console.error(...a),
    locateFile: (p) => 'runtime/' + p,
    setStatus: (t) => { if (t) log('rt: ' + t); },
    totalDependencies: 0, monitorRunDependencies: () => {},
    preRun: [() => {
      // Directory-mode game: write every file into MEMFS under /home/web_user/love/
      const M = window.LoveState, root = '/home/web_user/love';
      M.FS_createPath('/home/web_user', 'love', true, true);
      const made = new Set();
      for (const [name, data] of Object.entries(files)) {
        if (name.endsWith('/')) continue;
        const i = name.lastIndexOf('/'); const dir = i < 0 ? '' : name.slice(0, i);
        if (dir && !made.has(dir)) { M.FS_createPath(root, dir, true, true); made.add(dir); }
        M.FS_createDataFile(root + (dir ? '/' + dir : ''), name.slice(i + 1), data, true, true, true);
        delete files[name];
      }
    }],
  };
  window.__sendViewport = sendViewport;
  const s = document.createElement('script'); s.src = 'runtime/love.js';
  s.onload = () => {
    setTimeout(sendViewport, 500); setTimeout(sendViewport, 2500);
    Love(window.LoveState).catch((e) => { console.error(e); status('Engine failed: ' + e); });
  };
  s.onerror = () => status('Could not load the engine (runtime/love.js)');
  document.body.appendChild(s);
}

/* ---------- saves export ---------- */
async function exportSaves() {
  const FS = window.LoveState && window.LoveState.FS;
  if (!FS) { status('Start the game once, then export.'); return; }
  const out = {}; const base = '/home/web_user/savedir';
  (function walk(p) { for (const n of FS.readdir(p)) { if (n === '.' || n === '..') continue; const f = p + '/' + n; const st = FS.stat(f);
    if (FS.isDir(st.mode)) walk(f); else out[f.slice(base.length + 1)] = FS.readFile(f); } })(base);
  const blob = new Blob([fflate.zipSync(out)], { type: 'application/zip' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'balatro-web-saves.zip' }); a.click();
}

/* ---------- keys (host-only; browser-local) ---------- */
const Keys = window.BalatroKeys = {
  get openrouter() { return localStorage.getItem('bw.key.openrouter') || ''; },
  get model() { return localStorage.getItem('bw.model') || ''; },
  open() { $('k-openrouter').value = Keys.openrouter; $('k-model').value = Keys.model; $('keys').showModal(); },
  async ensure() {          // resolves with a key or '' if the user cancels
    if (Keys.openrouter) return Keys.openrouter;
    if (isDev) { try { const r = await fetch('/__devenv'); if (r.ok) { const j = await r.json(); if (j.OPENROUTER_API_KEY) return j.OPENROUTER_API_KEY; } } catch {} }
    Keys.open(); return new Promise((res) => $('keys').addEventListener('close', () => res(Keys.openrouter), { once: true }));
  },
};
$('keys').addEventListener('close', () => {
  const v = $('keys').returnValue;
  if (v === 'save') { localStorage.setItem('bw.key.openrouter', $('k-openrouter').value.trim()); localStorage.setItem('bw.model', $('k-model').value.trim()); }
  if (v === 'clear') { localStorage.removeItem('bw.key.openrouter'); localStorage.removeItem('bw.model'); }
});

/* ---------- UI wiring ---------- */
async function showStep() {
  const meta = await idb.get('game.meta').catch(() => null);
  $('step-file').classList.toggle('hidden', !!meta);
  $('step-play').classList.toggle('hidden', !meta);
  if (meta) $('gameinfo').textContent = `${meta.name} · version ${meta.version} · ${(meta.size / 1e6).toFixed(1)} MB stored in this browser`;
}
$('file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { await importFile(f); await showStep(); } catch (err) { status(err.message); }
});
$('play').addEventListener('click', play);
$('quality').value = String(prefs.quality);
$('showperf').checked = prefs.perf; $('perf').classList.toggle('hidden', !prefs.perf);
$('showperf').addEventListener('change', (e) => { prefs.perf = e.target.checked; $('perf').classList.toggle('hidden', !e.target.checked); });
$('settings').addEventListener('click', () => Keys.open());
$('export').addEventListener('click', exportSaves);
$('forget').addEventListener('click', async () => { if (confirm('Remove the stored game file from this browser? (Saves are kept.)')) { await idb.del('game'); await idb.del('game.meta'); showStep(); } });
if ('serviceWorker' in navigator && !isDev) navigator.serviceWorker.register('sw.js').catch(() => {});
if (isDev) { const s = document.createElement('script'); s.src = '/dev/beacon.js'; document.head.appendChild(s); }
showStep();
const qs = new URLSearchParams(location.search);
async function devAutoload() {   // dev only: pull the developer's own game file from the local dev server
  if (!isDev || !qs.has('devgame')) return;
  if (await idb.get('game.meta') && !qs.has('reload')) return;
  const r = await fetch('/__devgame'); if (!r.ok) return log('no /__devgame');
  await importFile(new File([await r.blob()], 'game.love'));
  await showStep();
}
devAutoload().then(() => { if (qs.has('autoplay')) idb.get('game').then((z) => z && play()); });
window.BalatroApp = { play, exportSaves, flushSaves, get quality() { return quality; } };
})();
