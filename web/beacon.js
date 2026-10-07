// Mirror console/errors/visibility/rAF heartbeat to the dev server's /__log (see dev_server.py).
(function () {
  if (window.__beacon) return; window.__beacon = true; window.__log = [];
  // Dev channel. With window.BW_DEV = {base, token, id} the same log/command plumbing works against a
  // machine that is always on (over Tailscale), instead of a server on this phone.
  const DEV = window.BW_DEV || null;
  // Build URLs the safe way (URLSearchParams) so a token/id can never corrupt the query string.
  function url(path, params) {
    const u = DEV ? new URL(DEV.base + path) : new URL(path, location.href);
    if (DEV) u.searchParams.set('token', DEV.token);
    if (params && 'id' in params) u.searchParams.set('id', DEV ? (DEV.id || '') : (window.BW_TAG || ''));
    return u.toString();
  }
  const send = (s) => { window.__log.push(s); const u = url('/__log');
    try { (navigator.sendBeacon && !DEV) ? navigator.sendBeacon(u, s) : fetch(u, { method: 'POST', body: s, keepalive: true }); } catch (e) {} };
  ['log', 'info', 'warn', 'error'].forEach(k => { const o = console[k]; console[k] = function (...a) { send(k + ': ' + a.map(String).join(' ')); o.apply(console, a); }; });
  addEventListener('error', e => send('ONERROR: ' + e.message + ' @' + (e.filename || '') + ':' + e.lineno));
  addEventListener('unhandledrejection', e => send('REJECTION: ' + (e.reason && (e.reason.stack || e.reason))));
  document.addEventListener('visibilitychange', () => send('visibility: ' + document.visibilityState));
  send('BOOT ' + location.pathname + ' vis=' + document.visibilityState + ' coi=' + self.crossOriginIsolated + ' sab=' + (typeof SharedArrayBuffer) + ' ' + innerWidth + 'x' + innerHeight + ' dpr=' + devicePixelRatio + ' sw=' + ('serviceWorker' in navigator) + ' ua=' + navigator.userAgent);
  let frames = 0; const tick = () => { frames++; requestAnimationFrame(tick); }; requestAnimationFrame(tick);
  let beats = 0; const hb = setInterval(() => { send('heartbeat rafFrames=' + frames + ' vis=' + document.visibilityState); frames = 0; if (++beats > 20) clearInterval(hb); }, 3000);
  window.__send = send;
})();
// Remote control: agent queues commands via POST /__cmd; page polls. "shot" captures the WebGL canvas
// right after the app's own rAF callback (so the drawing buffer is still valid), "eval <js>" runs JS.
(function () {
  let wantShot = false;
  const _raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function (cb) {
    return _raf(function (t) {
      cb(t);
      if (wantShot) {
        const c = document.getElementById('canvas') || document.querySelector('canvas');
        if (c && c.width > 300 && (!c.style || getComputedStyle(c).visibility !== 'hidden')) {
          wantShot = false;
          try { const u = c.toDataURL('image/png'); fetch(url('/__shot'), { method: 'POST', body: u }); window.__send('shot ' + c.width + 'x' + c.height); }
          catch (e) { window.__send('shot error ' + e); }
        }
      }
    });
  };
  window.__shot = () => { wantShot = true; };
  setInterval(async () => {
    try {
      const cmd = (await (await fetch(url('/__cmd', { id: 1 }), { cache: 'no-store' })).text()).trim();
      if (!cmd) return;
      if (cmd === 'play') { const b = document.getElementById('play'); b ? b.click() : window.__send('no play button (already running?)'); }
      else if (cmd === 'tap') { const c = document.getElementById('canvas');
        for (const t of ['pointerdown','pointerup','touchstart','touchend']) c.dispatchEvent(t.startsWith('touch') && window.TouchEvent ? new TouchEvent(t, {bubbles:true}) : new PointerEvent(t, {bubbles:true}));
        window.__send('tapped'); }
      else if (cmd === 'shot') { window.BalatroBridge && window.LoveState && window.LoveState.love_send_event ? BalatroBridge.send('shot') : window.__shot(); }
      else if (cmd.startsWith('lua ')) { window.BalatroBridge ? BalatroBridge.send('eval', cmd.slice(4)) : window.__send('no bridge'); }
      else if (cmd.startsWith('eval ')) {
        try { let r = await (0, eval)('(async()=>{' + cmd.slice(5) + '})()'); window.__send('eval> ' + JSON.stringify(r)); }
        catch (e) { window.__send('eval error ' + e); }
      }
    } catch (e) {}
  }, 1000);
})();
