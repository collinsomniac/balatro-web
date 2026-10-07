// Balatro web co-op — browser client + love.js bridge. No dependencies. Load as an ES module
// (<script type="module">); it also sets window.Coop for non-module code.
// SPDX-License-Identifier: GPL-3.0-or-later
//
//   import { Coop } from './client.js'
//   const c = Coop.connect('wss://relay.example/ws', { role: 'host', name: 'Ana' })        // create room
//   const c = Coop.connect('wss://relay.example/ws', { role: 'guest', room: 'KXQPT', name: 'Bo' })
//   c.on('joined', s => shareLink(Coop.inviteLink(s.code)))
//   c.on('message', m => ...)  c.on('card_request', m => ...)  c.send({action:'playHand', ...})
//   Coop.attachLove(Module, c)   // wire to the LÖVE runtime (see below)
//
// Lua <-> JS bridge (love.js 11.5 compat, alexjgriffith/update-lovejs runtime):
//   JS → Lua : Module.love_send_event('coop', jsonString, 0)
//              = cwrap('JS_send_event') → SDL_USEREVENT → love event 'userevent'(name,data,code)
//              → default love.userevent re-pushes it as love event 'coop' IF love.handlers.coop exists
//              → next frame Balatro's love.run calls love.handlers.coop(jsonString, 0).
//   Lua → JS : print('__WEB__:coop:' .. json.encode(msg))  → Module.print → Coop.handlePrintLine().
//
// Security: this module never reads or sends the OpenRouter key. A last-chance guard refuses to
// transmit anything that looks like an API key.

const SECRET_RE = /sk-or-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9]{32,}|Bearer\s+[A-Za-z0-9._-]{20,}/
const PRINT_PREFIX = '__WEB__:coop:'
const LS = 'balatro.coop.session' // sessionStorage+localStorage: {url, code, token, playerId, name}

class Emitter {
  constructor () { this._h = new Map() }
  on (ev, fn) { if (!this._h.has(ev)) this._h.set(ev, new Set()); this._h.get(ev).add(fn); return () => this.off(ev, fn) }
  off (ev, fn) { this._h.get(ev)?.delete(fn) }
  once (ev, fn) { const off = this.on(ev, (...a) => { off(); fn(...a) }); return off }
  emit (ev, ...a) { for (const fn of [...(this._h.get(ev) || [])]) { try { fn(...a) } catch (e) { console.error('[coop]', ev, e) } } }
}

class CoopConnection extends Emitter {
  constructor (url, opts = {}) {
    super()
    this.url = url
    this.opts = { role: 'guest', name: 'Player', gameMode: 'coop', options: {}, keepAliveMs: 10000, maxBackoffMs: 8000, ...opts }
    this.state = 'idle' // idle | connecting | open | joined | reconnecting | closed
    this.session = null // {code, playerId, reconnectToken, isHost, hostId, players, ...}
    this.players = new Map()
    this.queue = []     // outgoing messages while not joined
    this._attempt = 0
    this._closedByUser = false
    this._reqSeq = 0
    this._onVis = () => this._visibility()
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._onVis)
      addEventListener('pageshow', this._onVis)
      addEventListener('online', this._onVis)
      addEventListener('pagehide', () => this._raw({ action: 'away' }))
    }
    const saved = loadSession()
    if (opts.resume !== false && saved && saved.url === url && (!opts.room || saved.code === String(opts.room).toUpperCase())) {
      this._resume = saved
    }
    this._open()
  }

  get isHost () { return !!this.session?.isHost }
  get code () { return this.session?.code }
  get playerId () { return this.session?.playerId }

  // ---- public API ----
  send (msg) {
    if (!msg || typeof msg.action !== 'string') throw new Error('send({action,...})')
    if (this.state !== 'joined') { this.queue.push(msg); return false }
    return this._raw(msg)
  }
  /** host: send to everyone (default), a playerId, or [playerIds]. `sticky` = replay to late joiners. */
  broadcast (msg, { to, sticky } = {}) { return this.send({ ...msg, ...(to ? { to } : {}), ...(sticky ? { sticky } : {}) }) }
  ready (on = true) { return this.send({ action: on ? 'readyLobby' : 'unreadyLobby' }) }
  startGame (fields) { return this.send({ action: 'startGame', ...fields }) }
  leave () { this._closedByUser = true; this._raw({ action: 'leaveLobby' }); clearSession(); this._teardown('left') }

  /** guest (or host itself): ask the host to generate a card for a topic / Wikipedia URL */
  requestCard (topic, extra = {}) {
    const reqId = `${this.playerId || 'p'}-${Date.now().toString(36)}-${++this._reqSeq}`
    const msg = { action: 'card_request', reqId, topic: String(topic).slice(0, 500), ...extra }
    if (this.isHost) queueMicrotask(() => this.emit('card_request', { ...msg, from: this.playerId }))
    else this.send(msg)
    return reqId
  }
  /** host only: publish a validated card spec to the whole room (and self via 'card_granted') */
  grantCard (card, { reqId, requester } = {}) {
    if (!this.isHost) throw new Error('only the host grants cards')
    const msg = { action: 'card_granted', reqId, requester, card }
    this.broadcast(msg, { sticky: `card:${card.id}` })
    this.emit('card_granted', { ...msg, from: this.playerId })
    this.emit('message', { ...msg, from: this.playerId })
  }
  rejectCard (reqId, requester, reason) {
    const msg = { action: 'card_rejected', reqId, reason: String(reason).slice(0, 200) }
    if (requester && requester !== this.playerId) this.broadcast(msg, { to: requester })
    else this.emit('card_rejected', { ...msg, from: this.playerId })
  }

  // ---- internals ----
  _open () {
    this.state = this._attempt ? 'reconnecting' : 'connecting'
    this.emit('status', this.state)
    let ws
    try { ws = new WebSocket(this.url) } catch (e) { return this._scheduleReconnect() }
    this.ws = ws
    ws.onopen = () => {
      this.state = 'open'
      const s = this._resume || (this.session && { code: this.session.code, token: this.session.reconnectToken })
      if (s?.token) this._raw({ action: 'rejoinLobby', code: s.code, reconnectToken: s.token }, true)
      else if (this.opts.role === 'host') this._raw({ action: 'createLobby', gameMode: this.opts.gameMode, username: this.opts.name, options: this.opts.options, maxPlayers: this.opts.maxPlayers }, true)
      else this._raw({ action: 'joinLobby', code: String(this.opts.room || '').toUpperCase(), username: this.opts.name }, true)
      clearInterval(this._ka)
      this._ka = setInterval(() => this._raw({ action: 'keepAlive', t: Date.now() }, true), this.opts.keepAliveMs)
    }
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data) } catch { return } this._onMessage(m) }
    ws.onclose = (ev) => {
      clearInterval(this._ka)
      if (this.ws !== ws) return
      if (this._closedByUser || this.state === 'closed') return
      this._scheduleReconnect(ev.code)
    }
    ws.onerror = () => {}
  }

  _onMessage (m) {
    switch (m.action) {
      case 'connected': case 'keepAliveAck': return
      case 'joinedLobby': case 'rejoinedLobby': {
        const fresh = m.action === 'joinedLobby'
        this.session = m; this._resume = null; this._attempt = 0
        this.players = new Map(m.players.map(p => [p.id, p]))
        saveSession({ url: this.url, code: m.code, token: m.reconnectToken, playerId: m.playerId, name: this.opts.name })
        this.state = 'joined'; this.emit('status', 'joined')
        this.emit(fresh ? 'joined' : 'rejoined', m)
        const q = this.queue; this.queue = []; for (const x of q) this._raw(x)
        break
      }
      case 'error':
        if (m.code === 'rejoin_failed') { // seat expired: fall back to a fresh join/create once
          clearSession(); this._resume = null; this.session = null
          this.emit('rejoin_failed', m)
          if (this.opts.role === 'guest' && this.opts.room) this._raw({ action: 'joinLobby', code: this.opts.room.toUpperCase(), username: this.opts.name }, true)
          else this._teardown('rejoin_failed')
        }
        this.emit('error', m); break
      case 'lobbyPlayerJoined': case 'lobbyPlayerUpdated':
        this.players.set(m.player.id, { ...this.players.get(m.player.id), ...m.player }); this.emit('players', [...this.players.values()]); break
      case 'lobbyPlayerLeft':
        this.players.delete(m.playerId); this.emit('players', [...this.players.values()]); break
      case 'lobbyClosed': case 'kickedFromLobby':
        clearSession(); this.emit(m.action, m); this._teardown(m.reason || m.action); break
    }
    this.emit(m.action, m)   // fine-grained: c.on('card_granted', ...)
    this.emit('message', m)  // everything (the love bridge listens here)
  }

  _raw (msg, control = false) {
    const s = JSON.stringify(msg)
    if (SECRET_RE.test(s)) { console.error('[coop] refused to send a payload that looks like an API key'); return false }
    if (!this.ws || this.ws.readyState !== 1) { if (!control && msg.action !== 'away') this.queue.push(msg); return false }
    this.ws.send(s); return true
  }

  _scheduleReconnect (code) {
    if (this._closedByUser) return
    if (code === 4000) return this._teardown('replaced') // another tab took this seat
    this.state = 'reconnecting'; this.emit('status', 'reconnecting')
    const delay = Math.min(this.opts.maxBackoffMs, 500 * 2 ** this._attempt++) * (0.75 + Math.random() * 0.5)
    clearTimeout(this._rt)
    this._rt = setTimeout(() => this._open(), (typeof document !== 'undefined' && document.visibilityState === 'hidden') ? Math.max(delay, 5000) : delay)
  }

  _visibility () {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    // iOS Safari resumes suspended tabs with a dead socket that still says OPEN: probe & reconnect fast
    if (this.state === 'closed' || this._closedByUser) return
    if (!this.ws || this.ws.readyState > 1) { clearTimeout(this._rt); this._attempt = 0; return this._open() }
    let acked = false
    const off = this.once('keepAliveAck', () => { acked = true })
    this._raw({ action: 'keepAlive', t: Date.now() }, true)
    setTimeout(() => { off(); if (!acked && this.ws) { const w = this.ws; this.ws = null; try { w.close() } catch {} clearTimeout(this._rt); this._attempt = 0; this._open() } }, 2500)
  }

  _teardown (reason) {
    this.state = 'closed'; clearInterval(this._ka); clearTimeout(this._rt)
    try { this.ws?.close(1000, reason) } catch {}
    this.ws = null
    this.emit('status', 'closed'); this.emit('closed', reason)
  }
}

function saveSession (s) { try { sessionStorage.setItem(LS, JSON.stringify(s)); localStorage.setItem(LS, JSON.stringify(s)) } catch {} }
function loadSession () { try { return JSON.parse(sessionStorage.getItem(LS) || localStorage.getItem(LS) || 'null') } catch { return null } }
function clearSession () { try { sessionStorage.removeItem(LS); localStorage.removeItem(LS) } catch {} }

// ---------------- love.js bridge ----------------
let _bridge = null

/**
 * Wire a CoopConnection to the LÖVE runtime.
 *  - every relay message → Lua: Module.love_send_event('coop', json, 0)  (queued until runtime is ready)
 *  - Lua print('__WEB__:coop:{json}') → handled by Coop.handlePrintLine (call it from Module.print), or
 *    pass {wrapPrint:true} to wrap Module.print automatically.
 * Lua→JS message forms (field `op` is consumed by the bridge, everything else is relayed as-is):
 *   {"action":"playHand",...}                   → c.send(...)
 *   {"op":"broadcast","msg":{...},"to":id,"sticky":"key"}  (host)
 *   {"op":"request_card","topic":"..."}          → c.requestCard(topic)
 *   {"op":"grant_card","card":{...},"reqId":..}  (host; normally JS does this after AI generation)
 *   {"op":"ready","value":true} | {"op":"leave"}
 */
function attachLove (Module, conn, { eventName = 'coop', wrapPrint = false } = {}) {
  const pending = []
  const ready = () => typeof Module?.love_send_event === 'function'
  const toLua = (obj) => {
    const s = JSON.stringify(obj)
    if (!ready()) { pending.push(s); return }
    while (pending.length) Module.love_send_event(eventName, pending.shift(), 0)
    Module.love_send_event(eventName, s, 0)
  }
  const flushTimer = setInterval(() => { if (ready() && pending.length) toLua({ action: 'bridgeReady' }) }, 250)
  const offs = [
    conn.on('message', m => toLua(m)),
    conn.on('status', s => toLua({ action: 'coopStatus', status: s, code: conn.code, playerId: conn.playerId, isHost: conn.isHost })),
    conn.on('closed', r => toLua({ action: 'coopClosed', reason: r })),
  ]
  _bridge = { Module, conn, toLua }
  if (wrapPrint && Module) {
    const orig = Module.print || console.log
    Module.print = (line) => { if (!handlePrintLine(line)) orig(line) }
  }
  if (conn.session) toLua({ ...conn.session, action: 'joinedLobby' })
  return () => { offs.forEach(f => f()); clearInterval(flushTimer); _bridge = null }
}

/** Call from Module.print. Returns true if the line was a co-op bridge line (and was consumed). */
function handlePrintLine (line) {
  if (typeof line !== 'string' || !line.startsWith(PRINT_PREFIX)) return false
  if (!_bridge) { console.warn('[coop] Lua sent coop message but no bridge attached'); return true }
  let m
  try { m = JSON.parse(line.slice(PRINT_PREFIX.length)) } catch (e) { console.error('[coop] bad JSON from Lua', line); return true }
  const c = _bridge.conn
  switch (m.op) {
    case undefined: c.send(m); break
    case 'broadcast': c.broadcast(m.msg, { to: m.to, sticky: m.sticky }); break
    case 'request_card': c.requestCard(m.topic, m.extra); break
    case 'grant_card': c.grantCard(m.card, { reqId: m.reqId, requester: m.requester }); break
    case 'ready': c.ready(m.value !== false); break
    case 'leave': c.leave(); break
    case 'ping': _bridge.toLua({ action: 'pong', t: m.t }); break
    default: console.warn('[coop] unknown op from Lua', m.op)
  }
  return true
}

function inviteLink (code, base = (typeof location !== 'undefined' ? location.href : '')) {
  const u = new URL(base); u.hash = ''; u.searchParams.set('room', code); return u.toString()
}
/** Parse ?room=CODE&relay=wss://... from the page URL */
function fromLocation (loc = (typeof location !== 'undefined' ? location : null)) {
  if (!loc) return {}
  const q = new URLSearchParams(loc.search)
  return { room: q.get('room')?.toUpperCase() || null, relay: q.get('relay') || null }
}

export const Coop = {
  connect: (url, opts) => new CoopConnection(url, opts),
  attachLove, handlePrintLine, inviteLink, fromLocation, clearSession,
  PRINT_PREFIX, CoopConnection,
}
if (typeof window !== 'undefined') window.Coop = Coop
export default Coop
