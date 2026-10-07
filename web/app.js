/* Balatro Web: bring-your-own-game loader + full-screen shell for love.js (LÖVE 11.5, single-threaded).
 * The player's game file is stored ONLY in their browser (IndexedDB) and is patched at every launch from
 * patches/*.json + web_shim.lua, so patch updates apply without re-picking the file. */
(() => {
'use strict';
const $ = (id) => document.getElementById(id);
const isDev = ['127.0.0.1', 'localhost'].includes(location.hostname);
const TAG = window.BW_TAG = new URLSearchParams(location.search).get('tag') || (isDev ? 'tab' + Math.random().toString(36).slice(2, 6) : '');
const qs = new URLSearchParams(location.search);
const log = (...a) => { const line = a.join(' '); (window.__send ? __send(line) : console.log(line));
  const el = $('log'); if (el) { el.textContent += line + '\n'; el.scrollTop = el.scrollHeight; if (el.textContent.length > 20000) el.textContent = el.textContent.slice(-15000); } };
const status = (t) => { $('status').textContent = t || ''; if (t) log('status: ' + t); };
const banner = (msg, kind) => { const b = $('banner'); b.textContent = msg; b.className = kind || ''; b.classList.remove('hidden'); log('BANNER: ' + msg); };
const clearBanner = () => $('banner').classList.add('hidden');
addEventListener('error', (e) => banner('Error: ' + (e.message || e.error || 'unknown') + '  (line ' + (e.lineno || '?') + ')'));
addEventListener('unhandledrejection', (e) => banner('Error: ' + (e.reason && (e.reason.message || e.reason))));

/* ---------- stage/progress UI ---------- */
const UI = {
  stage(pct, name, detail) { $('bar').style.width = pct + '%'; $('stage').textContent = name; $('detail').textContent = detail || ''; },
  show(which) { for (const s of ['setup', 'loading', 'ready']) $(s).classList.toggle('hidden', s !== which); },
  get bodyActive() { return document.body.classList.contains('running'); },
  body(running) { document.body.classList.toggle('running', running); $('menu').classList.toggle('hidden', !running); },
};

const prefs = {
  get quality() { return parseFloat(localStorage.getItem('bw.quality') || '2'); },
  set quality(v) { localStorage.setItem('bw.quality', String(v)); },
  get perf() { return localStorage.getItem('bw.perf') === '1'; },
  set perf(v) { localStorage.setItem('bw.perf', v ? '1' : '0'); },
  get skipsplash() { return localStorage.getItem('bw.skipsplash') !== '0'; },
  set skipsplash(v) { localStorage.setItem('bw.skipsplash', v ? '1' : '0'); },
  get src() { return localStorage.getItem('bw.src') || ''; },
  set src(v) { localStorage.setItem('bw.src', v); },
};

/* ---------- storage ---------- */
const idb = (() => {
  let dbp;
  const db = () => dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('balatro-web', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const tx = async (mode, fn) => { const d = await db(); return new Promise((res, rej) => {
    const t = d.transaction('kv', mode); const r = fn(t.objectStore('kv'));
    t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); }); };
  return { get: (k) => tx('readonly', (s) => s.get(k)), set: (k, v) => tx('readwrite', (s) => s.put(v, k)), del: (k) => tx('readwrite', (s) => s.delete(k)) };
})();

/* ---------- streamed download with progress (also used to preload the wasm engine) ---------- */
async function fetchWithProgress(url, onPct) {
  const res = await fetch(url); if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const total = +(res.headers.get('Content-Length') || 0);
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader(); const chunks = []; let got = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; onPct && onPct(got / total, got, total); }
  const out = new Uint8Array(got); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

/* ---------- game file: locate the zip inside Balatro.exe (a fused LÖVE exe) ---------- */
function extractZip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      const cdSize = dv.getUint32(i + 12, true), cdOff = dv.getUint32(i + 16, true);
      const start = i - cdSize - cdOff;
      if (start >= 0) return u8.subarray(start);
    }
  }
  throw new Error('No game archive found in that file. Pick Balatro.exe or a game.love.');
}
async function importBytes(u8, name) {
  const zip = extractZip(u8);
  const meta = fflate.unzipSync(zip, { filter: (f) => f.name === 'version.jkr' });
  const version = new TextDecoder().decode(meta['version.jkr'] || new Uint8Array()).split('\n')[0] || 'unknown';
  await idb.set('game', zip.slice());
  await idb.set('game.meta', { name, size: zip.length, version, added: Date.now() });
  return version;
}

/* ---------- patching: exact-match, fails loudly ---------- */
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
    const s = texts[p.file] ?? dec.decode(files[p.file]);
    const n = s.split(p.find).length - 1;
    if (n !== 1) throw new Error(`Patch "${p.label}" failed in ${p.file}: ${n} matches (game ${ver}). This version isn't supported yet.`);
    texts[p.file] = s.replace(p.find, () => p.replace);
  }
  for (const [f, s] of Object.entries(texts)) files[f] = enc.encode(s);
  files['web_shim.lua'] = enc.encode(shim);          // shipped as part of the overlay archive
  return ver;
}

/* ---------- display ---------- */
let quality = prefs.quality;
try { Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => quality }); } catch (e) { log('dpr override failed ' + e); }
function fitCanvas() {
  const portrait = innerHeight > innerWidth;
  $('rotate').classList.toggle('hidden', !(UI.bodyActive && portrait));
}
addEventListener('resize', fitCanvas); addEventListener('orientationchange', () => setTimeout(fitCanvas, 300));

/* ---------- audio: WebKit suspends AudioContexts until a gesture ---------- */
const audioCtxs = [];
for (const n of ['AudioContext', 'webkitAudioContext']) {
  const AC = window[n]; if (!AC) continue;
  window[n] = class extends AC { constructor(...a) { super(...a); audioCtxs.push(this); } };
}
const unlock = (c) => {   // iOS: play a silent buffer inside a real gesture, then resume
  if (c.__unlocked) return; c.__unlocked = true;
  try { const b = c.createBuffer(1, 1, 22050), src = c.createBufferSource();
    src.buffer = b; src.connect(c.destination); src.start(0); } catch {}
};
const resumeAudio = () => { audioCtxs.forEach(unlock); const r = audioCtxs.map((c) => c.state !== 'running' && c.resume().catch(() => {}));
  if (window.__send) __send(`audio: ${audioCtxs.length} ctx, ${audioCtxs.map((c) => c.state).join('/') || 'none'}`); return r; };
['pointerdown', 'touchend', 'keydown', 'click'].forEach((e) => addEventListener(e, resumeAudio, { capture: true, passive: true }));
document.addEventListener('visibilitychange', () => { if (!document.hidden) resumeAudio(); });

/* ---------- perf overlay ---------- */
let rafFrames = 0, lastPerf = {};
(function raf() { rafFrames++; requestAnimationFrame(raf); })();
setInterval(() => {
  if (prefs.perf && document.body.classList.contains('running')) {
    const p = lastPerf, c = $('canvas');
    $('perf').textContent = `page ${rafFrames}fps  lua ${p.fps ?? '-'}fps  slow ${p.long ?? 0}  worst ${p.worst_ms ?? 0}ms\n${c.width}×${c.height} @${quality}×  lua ${((p.mem_kb || 0) / 1024).toFixed(0)}MB`;
  }
  rafFrames = 0;
}, 1000);

/* ---------- Lua <-> JS bridge ---------- */
const Bridge = window.BalatroBridge = {
  handlers: {}, on(kind, fn) { (this.handlers[kind] ||= []).push(fn); },
  send(cmd, data) { const M = window.LoveState; if (M && M.love_send_event) M.love_send_event('web', JSON.stringify({ c: cmd, d: data ?? null }), 0); },
  fromLua(line) {
    const sp = line.indexOf(' '), kind = sp < 0 ? line : line.slice(0, sp), payload = sp < 0 ? '' : line.slice(sp + 1);
    if (kind === 'perf') { try { lastPerf = JSON.parse(payload); } catch {} if (isDev) log('perf ' + payload); }
    else if (kind === 'boot') { log('engine boot ' + payload); }
    else if (kind === 'viewport') { log('viewport ' + payload); }
    else if (kind === 'shot') { if (isDev) fetch('/__shot', { method: 'POST', body: 'data:image/png;base64,' + payload }).then(() => log('shot ok ' + payload.length)); }
    else if (kind === 'sync') flushSaves('lua');
    else if (kind === 'error') {
      console.error('LUA ERROR ' + payload);
      const first = payload.split('\n')[0];
      log('LUA ERROR ' + first);
      banner('Game error: ' + first + '\nIf it repeats, tap "Reset progress" on the menu (☰) — a save written during a crash can cause this.', '');
    }
    else log('lua ' + kind + ' ' + payload);
    (this.handlers[kind] || []).forEach((fn) => fn(payload));
  },
};
function sendViewport() { if (window.LoveState && window.LoveState.love_send_event) Bridge.send('viewport', { w: Math.round(innerWidth), h: Math.round(innerHeight), dpr: quality }); }
let vpT;
addEventListener('resize', () => { clearTimeout(vpT); vpT = setTimeout(() => { sendViewport(); fitCanvas(); }, 250); });
addEventListener('orientationchange', () => setTimeout(() => { sendViewport(); fitCanvas(); }, 400));
function flushSaves(why) { const FS = window.LoveState && window.LoveState.FS; if (!FS) return;
  try { FS.syncfs(false, (e) => e && log('syncfs ' + why + ' ' + e)); } catch (e) { log('flush error ' + e); } }
addEventListener('pagehide', () => flushSaves('pagehide'));
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSaves('hidden'); });
Bridge.on('boot', () => { sendViewport(); Bridge.send('opts', { fps_cap: 60, skip_splash: prefs.skipsplash }); });

/* ---------- launch ---------- */
let engineBytes = null, started = false;
async function preloadEngine() {
  if (engineBytes) return engineBytes;
  UI.stage(8, 'Downloading engine…', 'LÖVE 11.5 · WebAssembly');
  engineBytes = await fetchWithProgress('runtime/love.wasm', (p, got, total) =>
    UI.stage(8 + p * 42, 'Downloading engine…', `${mb(got)} of ${mb(total)}`));
  return engineBytes;
}

async function play() {
  if (started) {                    // engine already running: just bring it back to the front
    UI.show(null); UI.body(true); sendViewport(); fitCanvas(); return;
  }
  const zip = await idb.get('game');
  if (!zip) { UI.show('setup'); return; }
  started = true;
  UI.show('loading');
  try { await navigator.storage?.persist?.(); } catch {}
  try { await preloadEngine(); } catch (e) { started = false; UI.stage(0, 'Engine download failed', String(e)); return; }

  UI.stage(55, 'Patching game…', 'reading your copy and applying the web patch set');
  const t0 = performance.now();
  const patchSet = await loadPatchSet();
  const files = fflate.unzipSync(zip);
  let ver;
  try { ver = applyPatches(files, patchSet); }
  catch (e) { started = false; UI.stage(0, 'Patching failed', e.message); log('' + e); return; }
  const patchMs = Math.round(performance.now() - t0);
  log(`patched ${ver} in ${patchMs}ms (${Object.keys(files).length} files)`);
  UI.stage(70, 'Starting engine…', `patched ${ver} in ${patchMs} ms`);
  idb.del('game.tmp').catch(() => {});

  quality = parseFloat($('quality').value); prefs.quality = quality;
  try { navigator.wakeLock && (window.__wake = await navigator.wakeLock.request('screen')); } catch {}
  UI.body(true); fitCanvas();

  const canvas = $('canvas');
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); log('graphics context lost'); started = false; UI.body(false); UI.show('ready'); }, false);

  const gl = { frames: 0, t0: performance.now(), showed: false };
  setTimeout(() => {
    if (!lastPerf || lastPerf.fps === undefined) {
      banner('The engine started but never ran a frame. Pull to refresh; if it repeats, tap "Copy details" and send it over.', 'info');
      UI.show('loading');
    }
  }, 25000);
  Bridge.on('perf', () => {
    const secs = ((performance.now() - gl.t0) / 1000).toFixed(0);
    const info = `state ${lastPerf.state ?? '?'} · ${lastPerf.fps ?? 0} fps · ${((lastPerf.mem_kb || 0) / 1024).toFixed(0)} MB Lua heap · ${secs}s`;
    $('chip').textContent = info;
    if (lastPerf.state === 11 && !gl.showed) {
      gl.menuFrames = (gl.menuFrames || 0) + 1;
      UI.stage(100, 'Ready', 'menu reached after ' + secs + ' s');
      if (gl.menuFrames >= 2) {
        gl.showed = true;
        setTimeout(() => { UI.show(null); UI.body(true); $('chip').classList.remove('hidden');
          setTimeout(() => $('chip').classList.add('hidden'), 6000); fitCanvas(); }, 300);
      }
    } else if (!gl.showed) {
      UI.stage(88, 'Loading game…', info);
      if (performance.now() - gl.t0 > 12000) $('skipwait').classList.remove('hidden');
      if (performance.now() - gl.t0 > 45000 && !gl.warned) {
        gl.warned = true;
        banner('Still loading after 45 s. Tap "Copy details" and send it over — the log will say where it stopped.', 'info');
        UI.show('loading');
      }
    }
  });

  window.LoveState = {
    arguments: [], canvas, wasmBinary: engineBytes,
    print: (...a) => { const t = a.join(' '); if (t.startsWith('__WEB__:')) Bridge.fromLua(t.slice(8)); else if (isDev) log('lua: ' + t); },
    printErr: (...a) => console.error(...a),
    locateFile: (p) => 'runtime/' + p,
    setStatus: (t) => t && log('rt: ' + t),
    totalDependencies: 0, monitorRunDependencies: (n) => n && UI.stage(86, 'Preparing…', n + ' steps left'),
    preRun: [() => {
      // Write the patched game straight into the engine's filesystem as a directory (LÖVE refuses to mount
      // an archive that sits inside the game folder, so a zip overlay is not an option).
      const M = window.LoveState, root = '/home/web_user/love';
      M.FS_createPath('/home/web_user', 'love', true, true);
      const made = new Set();
      for (const [name, data] of Object.entries(files)) {
        if (name.endsWith('/')) continue;
        const i = name.lastIndexOf('/'), dir = i < 0 ? '' : name.slice(0, i);
        if (dir && !made.has(dir)) { M.FS_createPath(root, dir, true, true); made.add(dir); }
        M.FS_createDataFile(root + (dir ? '/' + dir : ''), name.slice(i + 1), data, true, true, true);
        delete files[name];
      }
    }],
  };
  const s = document.createElement('script'); s.src = 'runtime/love.js';
  s.onload = () => { setTimeout(sendViewport, 800);
    Love(window.LoveState).catch((e) => { console.error(e); started = false; UI.stage(0, 'Engine failed', String(e)); log('engine failed ' + e); }); };
  s.onerror = () => { started = false; UI.stage(0, 'Could not load runtime/love.js', ''); };
  document.body.appendChild(s);
}

/* ---------- load from the player's computer ---------- */
async function scanComputer() {
  const base = ($('src').value || '').trim().replace(/\/$/, '');
  if (!base) return status('Enter the address of your computer first.');
  prefs.src = base; status('Looking for games…');
  try {
    const r = await fetch(base + '/manifest.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    $('found').innerHTML = '';
    if (!j.files.length) return status('No .exe or .love files in that folder.');
    for (const f of j.files) {
      const li = document.createElement('li');
      li.innerHTML = `<button class="btn">${f.name}</button> <span class="hint">${mb(f.size)} · ${new Date(f.mtime * 1000).toLocaleDateString()}</span>`;
      li.querySelector('button').onclick = () => downloadFrom(base, f);
      $('found').appendChild(li);
    }
    status(`Found ${j.files.length} on ${j.host}.`);
  } catch (e) { status('Could not reach that address: ' + e.message); }
}
async function downloadFrom(base, f) {
  UI.show('loading'); UI.stage(2, 'Downloading ' + f.name, 'from ' + base);
  try {
    const u8 = await fetchWithProgress(base + '/' + f.rel, (p, got, total) => UI.stage(2 + p * 50, 'Downloading ' + f.name, `${mb(got)} of ${mb(total)}`));
    UI.stage(54, 'Checking file…', '');
    const ver = await importBytes(u8, f.name);
    log(`imported ${f.name} (game ${ver})`);
    UI.stage(100, 'Ready', '');
    await preloadEngine().catch(() => {});
    showReady();
  } catch (e) { UI.stage(0, 'Download failed', e.message); log('download failed: ' + e.message); }
}

function details() {
  const c = $('canvas');
  return ['--- balatro web diagnostics ' + new Date().toISOString(),
    'ua: ' + navigator.userAgent,
    'standalone: ' + (matchMedia('(display-mode: standalone)').matches || navigator.standalone),
    'viewport: ' + innerWidth + 'x' + innerHeight + ' dpr=' + window.devicePixelRatio + ' quality=' + quality,
    'canvas: ' + c.width + 'x' + c.height + ' css=' + (c.clientWidth + 'x' + c.clientHeight),
    'coi: ' + self.crossOriginIsolated + ' SAB: ' + (typeof SharedArrayBuffer) + ' sw: ' + ('serviceWorker' in navigator),
    'engine: ' + (window.LoveState ? 'loaded' : 'not loaded') + ' started=' + started,
    'last perf: ' + JSON.stringify(lastPerf),
    'audio: ' + audioCtxs.map((x) => x.state).join('/'),
    '', '--- log ---', $('log').textContent].join('\n');
}
async function copyDetails() {
  const t = details();
  try { await navigator.clipboard.writeText(t); status('Diagnostics copied — paste them into the chat.'); }
  catch (e) { window.prompt('Copy these diagnostics:', t); }
  log('details copied (' + t.length + ' chars)');
}

/* Wipe the engine's saved state. A save written during a crashed run can make the game error on load,
 * and this is the recovery path (it also runs while the game is wedged). */
async function resetProgress() {
  if (!confirm('Delete the saved settings and progress kept in this browser?')) return;
  try { indexedDB.deleteDatabase('/home/web_user/savedir'); } catch (e) {}
  try {
    const FS = window.LoveState && window.LoveState.FS, base = '/home/web_user/savedir';
    if (FS) for (const n of FS.readdir(base)) { if (n === '.' || n === '..') continue;
      const p = base + '/' + n;
      try { FS.isDir(FS.stat(p).mode) ? FS.rmdir(p) : FS.unlink(p); } catch (e) {} }
  } catch (e) { log('reset: ' + e) }
  log('progress reset');
  location.reload();
}

/* ---------- saves export ---------- */
async function exportSaves() {
  const FS = window.LoveState && window.LoveState.FS;
  if (!FS) return status('Start the game once, then export.');
  const out = {}, base = '/home/web_user/savedir';
  (function walk(p) { for (const n of FS.readdir(p)) { if (n === '.' || n === '..') continue; const f = p + '/' + n, st = FS.stat(f);
    if (FS.isDir(st.mode)) walk(f); else out[f.slice(base.length + 1)] = FS.readFile(f); } })(base);
  const blob = new Blob([fflate.zipSync(out)], { type: 'application/zip' });
  Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'balatro-web-saves.zip' }).click();
}

/* ---------- keys (host-only, browser-local) ---------- */
const Keys = window.BalatroKeys = {
  get openrouter() { return localStorage.getItem('bw.key.openrouter') || ''; },
  get model() { return localStorage.getItem('bw.model') || ''; },
  open() { $('k-openrouter').value = Keys.openrouter; $('k-model').value = Keys.model; $('keys').showModal(); },
  async ensure() {
    if (Keys.openrouter) return Keys.openrouter;
    if (isDev) { try { const r = await fetch('/__devenv'); if (r.ok) { const j = await r.json(); if (j.OPENROUTER_API_KEY) return j.OPENROUTER_API_KEY; } } catch {} }
    Keys.open();
    return new Promise((res) => $('keys').addEventListener('close', () => res(Keys.openrouter), { once: true }));
  },
};
$('keys').addEventListener('close', () => {
  const v = $('keys').returnValue;
  if (v === 'save') { localStorage.setItem('bw.key.openrouter', $('k-openrouter').value.trim()); localStorage.setItem('bw.model', $('k-model').value.trim()); }
  if (v === 'clear') { localStorage.removeItem('bw.key.openrouter'); localStorage.removeItem('bw.model'); }
});

/* ---------- wiring ---------- */
async function showReady() {
  const standalone = matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || navigator.standalone;
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  $('fs').classList.toggle('hidden', standalone || !isIos);
  const meta = await idb.get('game.meta').catch(() => null);
  if (!meta) { UI.show('setup'); return; }
  $('gameinfo').textContent = `${meta.name} · game ${meta.version} · ${mb(meta.size)} kept in this browser`;
  UI.show('ready'); UI.body(false);
}
$('file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  UI.show('loading'); UI.stage(5, 'Reading ' + f.name, mb(f.size));
  try { await importBytes(new Uint8Array(await f.arrayBuffer()), f.name); UI.stage(100, 'Ready', ''); showReady(); }
  catch (err) { UI.stage(0, 'Could not read that file', err.message); log('import failed: ' + err.message); }
});
$('scan').addEventListener('click', scanComputer);
$('play').addEventListener('click', play);
$('skipwait').addEventListener('click', () => { log('user forced the game view'); UI.show(null); UI.body(true); $('chip').classList.remove('hidden'); fitCanvas(); });
$('copylog').addEventListener('click', copyDetails);
$('reload2').addEventListener('click', () => location.reload());
$('menu').addEventListener('click', () => { UI.body(false); UI.show('ready'); });
$('reload').addEventListener('click', () => location.reload());
$('settings').addEventListener('click', () => Keys.open());
$('export').addEventListener('click', exportSaves);
$('resetsave').addEventListener('click', resetProgress);
$('forget').addEventListener('click', async () => { if (confirm('Remove the stored game file from this browser? (Saves are kept.)')) { await idb.del('game'); await idb.del('game.meta'); UI.show('setup'); } });
$('quality').value = String(prefs.quality);
$('showperf').checked = prefs.perf; $('perf').classList.toggle('hidden', !prefs.perf);
$('showperf').addEventListener('change', (e) => { prefs.perf = e.target.checked; $('perf').classList.toggle('hidden', !e.target.checked); });
$('skipsplash').checked = prefs.skipsplash;
$('skipsplash').addEventListener('change', (e) => { prefs.skipsplash = e.target.checked; Bridge.send('opts', { fps_cap: 60, skip_splash: e.target.checked }); });
$('src').value = prefs.src || (isDev ? 'https://desktop-3rsf4r5.tailce70fb.ts.net' : '');
if ('serviceWorker' in navigator && !isDev) navigator.serviceWorker.register('sw.js').catch(() => {});
if (isDev) { const s = document.createElement('script'); s.src = '/dev/beacon.js'; document.head.appendChild(s); }

window.BalatroApp = { play, exportSaves, flushSaves, scanComputer, get quality() { return quality; } };

(async function boot() {
  if (isDev && qs.has('devgame') && (!(await idb.get('game.meta')) || qs.has('reload'))) {
    try { UI.show('loading'); UI.stage(2, 'Loading the developer copy…', ''); 
      const r = await fetch('/__devgame'); if (r.ok) { await importBytes(new Uint8Array(await r.arrayBuffer()), 'game.love'); } } catch (e) { log('devgame failed ' + e); }
  }
  await showReady();
  if (qs.has('autoplay')) await play();
})();
})();
