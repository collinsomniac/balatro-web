// Balatro web co-op relay — tiny, game-agnostic, host-authoritative WebSocket relay.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The server only knows rooms, players and roles. All game rules (blind targets,
// scores, lives, card generation) run in the HOST's browser. The server:
//   * creates rooms with 5-letter codes, admits guests, issues reconnect tokens
//   * relays: guest -> host (always), host -> all | playerId | [playerIds]
//   * stamps `from` on every relayed message (no spoofing)
//   * keeps a per-player outbox while a player is briefly gone (iOS backgrounding)
//   * replays "sticky" host messages (e.g. startGame) to late joiners / rejoiners
//   * heartbeats (ws ping/pong + app-level keepAlive), rate + size limits
//   * refuses anything that looks like an API key (defence in depth; key never needs to travel)
// Wire format: one JSON object per WebSocket text frame, `{ "action": "...", ...fields }`
// (BMP "legacy" flat shape; maps 1:1 onto BMP protocol-v2 envelopes via a bridge).

import http from 'node:http'
import crypto from 'node:crypto'
import { WebSocketServer } from 'ws'

export const PROTO = 1
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ' // no I/O (24^5 ≈ 8M codes)
const SECRET_RE = /sk-or-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9]{32,}|Bearer\s+[A-Za-z0-9._-]{20,}/
const SERVER_ACTIONS = new Set([
  'createLobby', 'joinLobby', 'rejoinLobby', 'leaveLobby', 'closeLobby',
  'readyLobby', 'unreadyLobby', 'lobbyOptions', 'kickPlayer',
  'startGame', 'returnToLobby', 'keepAlive', 'keepAliveAck', 'away',
])
const HOST_ONLY = new Set(['closeLobby', 'lobbyOptions', 'kickPlayer', 'startGame', 'returnToLobby'])

export function createRelay (opts = {}) {
  const cfg = {
    port: opts.port ?? Number(process.env.PORT || 8787),
    host: opts.host ?? process.env.HOST ?? '0.0.0.0',
    path: opts.path ?? '/ws',
    graceMs: opts.graceMs ?? Number(process.env.GRACE_MS || 180_000),
    heartbeatMs: opts.heartbeatMs ?? Number(process.env.HEARTBEAT_MS || 15_000),
    maxPlayers: opts.maxPlayers ?? Number(process.env.MAX_PLAYERS || 8),
    maxPayload: opts.maxPayload ?? 256 * 1024,
    outboxMax: opts.outboxMax ?? 500,
    rate: opts.rate ?? { perSec: 40, burst: 80 },
    allowedOrigins: opts.allowedOrigins ?? (process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : null),
    log: opts.log ?? ((...a) => console.log(new Date().toISOString(), ...a)),
    tap: opts.tap ?? null, // test hook: (direction, playerId|null, rawString) => void
  }
  const rooms = new Map() // code -> Room

  // ---------- helpers ----------
  const newId = () => crypto.randomBytes(6).toString('base64url')
  const newToken = () => crypto.randomBytes(18).toString('base64url')
  const newCode = () => {
    for (let i = 0; i < 50; i++) {
      let c = ''
      const b = crypto.randomBytes(5)
      for (let j = 0; j < 5; j++) c += CODE_ALPHABET[b[j] % CODE_ALPHABET.length]
      if (!rooms.has(c)) return c
    }
    throw new Error('code space exhausted')
  }
  const cleanName = (s) => String(s ?? 'Player').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24) || 'Player'
  const publicPlayer = (p) => ({ id: p.id, username: p.username, isHost: p.isHost, isReady: p.isReady, connected: !!p.ws, joinedAt: p.joinedAt })
  const playerList = (room) => [...room.players.values()].map(publicPlayer)

  function rawSend (ws, msg) {
    if (!ws || ws.readyState !== 1) return false
    const s = typeof msg === 'string' ? msg : JSON.stringify(msg)
    if (cfg.tap) cfg.tap('out', ws._pid ?? null, s)
    ws.send(s)
    return true
  }
  // deliver to a player; queue in outbox if they are in their grace window
  function deliver (p, msg) {
    const s = typeof msg === 'string' ? msg : JSON.stringify(msg)
    if (p.ws && p.ws.readyState === 1) return rawSend(p.ws, s)
    if (p.outbox.length < cfg.outboxMax) p.outbox.push(s)
    else p.outboxOverflow = true
    return false
  }
  const toAll = (room, msg, exceptId) => { for (const p of room.players.values()) if (p.id !== exceptId) deliver(p, msg) }
  const err = (ws, code, message, ref) => rawSend(ws, { action: 'error', code, message, ref })

  function lobbySnapshot (room, p) {
    return {
      code: room.code, playerId: p.id, reconnectToken: p.token, isHost: p.isHost,
      hostId: room.hostId, gameMode: room.gameMode, options: room.options,
      players: playerList(room), isInGame: room.inGame, proto: PROTO,
      graceMs: cfg.graceMs, maxPlayers: room.maxPlayers,
    }
  }

  function attach (ws, room, p) {
    if (p.ws && p.ws !== ws) { try { p.ws.close(4000, 'replaced') } catch {} }
    p.ws = ws; ws._pid = p.id; ws._room = room.code
    clearTimeout(p.graceTimer); p.graceTimer = null
  }

  function flushOutbox (p) {
    const q = p.outbox; p.outbox = []
    if (p.outboxOverflow) { rawSend(p.ws, { action: 'resyncRequired' }); p.outboxOverflow = false }
    for (const s of q) rawSend(p.ws, s)
  }

  function replaySticky (room, p) {
    for (const s of room.sticky.values()) deliver(p, s)
  }

  function closeRoom (room, reason) {
    for (const p of room.players.values()) {
      clearTimeout(p.graceTimer)
      if (p.ws) { rawSend(p.ws, { action: 'lobbyClosed', reason }); p.ws._room = null; p.ws._pid = null; try { p.ws.close(1000, reason) } catch {} }
    }
    rooms.delete(room.code)
    cfg.log('room closed', room.code, reason)
  }

  function removePlayer (room, p, reason) {
    clearTimeout(p.graceTimer)
    room.players.delete(p.id)
    if (p.ws) { p.ws._room = null; p.ws._pid = null }
    if (p.isHost) return closeRoom(room, reason === 'left' ? 'host_left' : 'host_timeout')
    toAll(room, { action: 'lobbyPlayerLeft', playerId: p.id, reason })
    if (room.players.size === 0) rooms.delete(room.code)
  }

  function onSocketGone (ws) {
    const room = rooms.get(ws._room); if (!room) return
    const p = room.players.get(ws._pid); if (!p || p.ws !== ws) return
    p.ws = null
    // graceful: keep the seat for graceMs (iOS Safari suspends background tabs)
    toAll(room, { action: 'lobbyPlayerUpdated', player: publicPlayer(p), reason: 'disconnected' }, p.id)
    if (p.isHost) toAll(room, { action: 'hostDisconnected', graceMs: cfg.graceMs }, p.id)
    p.graceTimer = setTimeout(() => removePlayer(room, p, 'timeout'), cfg.graceMs)
  }

  function rateOk (ws) {
    const now = Date.now()
    ws._tokens = Math.min(cfg.rate.burst, (ws._tokens ?? cfg.rate.burst) + (now - (ws._last ?? now)) / 1000 * cfg.rate.perSec)
    ws._last = now
    if (ws._tokens < 1) return false
    ws._tokens -= 1
    return true
  }

  // ---------- message handling ----------
  function handle (ws, raw) {
    if (cfg.tap) cfg.tap('in', ws._pid ?? null, raw)
    if (!rateOk(ws)) return err(ws, 'rate_limited', 'slow down')
    if (SECRET_RE.test(raw)) return err(ws, 'secret_detected', 'message looks like it contains an API key; refused')
    let m
    try { m = JSON.parse(raw) } catch { return err(ws, 'bad_json', 'invalid JSON') }
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.action !== 'string' || m.action.length > 64) {
      return err(ws, 'bad_message', 'expected {action:string,...}')
    }
    const a = m.action
    if (a === 'keepAlive') return rawSend(ws, { action: 'keepAliveAck', t: m.t })
    if (a === 'keepAliveAck') return

    // --- not yet in a room ---
    const room = rooms.get(ws._room)
    const me = room?.players.get(ws._pid)
    if (!me) {
      if (a === 'createLobby') {
        const code = newCode()
        const r = {
          code, hostId: null, players: new Map(), sticky: new Map(), inGame: false,
          gameMode: String(m.gameMode || 'coop').slice(0, 24),
          options: (m.options && typeof m.options === 'object') ? m.options : {},
          maxPlayers: Math.max(2, Math.min(cfg.maxPlayers, Number(m.maxPlayers) || cfg.maxPlayers)),
          createdAt: Date.now(),
        }
        const p = mkPlayer(m.username, true)
        r.hostId = p.id; r.players.set(p.id, p); rooms.set(code, r)
        attach(ws, r, p)
        cfg.log('room created', code)
        return rawSend(ws, { action: 'joinedLobby', ...lobbySnapshot(r, p) })
      }
      if (a === 'joinLobby') {
        const r = rooms.get(String(m.code || '').toUpperCase())
        if (!r) return err(ws, 'room_not_found', 'no such room', a)
        if (r.players.size >= r.maxPlayers) return err(ws, 'room_full', 'room is full', a)
        if (r.inGame && r.options.allowLateJoin === false) return err(ws, 'in_game', 'game already started', a)
        const p = mkPlayer(m.username, false)
        r.players.set(p.id, p)
        attach(ws, r, p)
        rawSend(ws, { action: 'joinedLobby', ...lobbySnapshot(r, p) })
        replaySticky(r, p)
        toAll(r, { action: 'lobbyPlayerJoined', player: publicPlayer(p) }, p.id)
        return
      }
      if (a === 'rejoinLobby') {
        const r = rooms.get(String(m.code || '').toUpperCase())
        const p = r && [...r.players.values()].find(x => x.token === m.reconnectToken && typeof m.reconnectToken === 'string')
        if (!p) return err(ws, 'rejoin_failed', 'room gone or seat expired', a)
        attach(ws, r, p)
        rawSend(ws, { action: 'rejoinedLobby', ...lobbySnapshot(r, p) })
        flushOutbox(p)
        toAll(r, { action: 'lobbyPlayerUpdated', player: publicPlayer(p), reason: 'reconnected' }, p.id)
        if (p.isHost) toAll(r, { action: 'hostReconnected' }, p.id)
        return
      }
      return err(ws, 'not_in_lobby', 'create or join a lobby first', a)
    }

    // --- in a room ---
    if (HOST_ONLY.has(a) && !me.isHost) return err(ws, 'not_host', `${a} is host-only`, a)
    switch (a) {
      case 'leaveLobby':
        return removePlayer(room, me, 'left')
      case 'closeLobby':
        return closeRoom(room, 'host_closed')
      case 'away': // best-effort hint before iOS suspends us
        return toAll(room, { action: 'lobbyPlayerUpdated', player: { ...publicPlayer(me), away: true }, reason: 'away' }, me.id)
      case 'readyLobby': case 'unreadyLobby':
        me.isReady = a === 'readyLobby'
        return toAll(room, { action: 'lobbyPlayerUpdated', player: publicPlayer(me), reason: a })
      case 'lobbyOptions':
        room.options = (m.options && typeof m.options === 'object') ? m.options : room.options
        return toAll(room, { action: 'lobbyOptions', options: room.options }, me.id)
      case 'kickPlayer': {
        const t = room.players.get(m.playerId)
        if (!t || t.isHost) return err(ws, 'bad_target', 'cannot kick', a)
        if (t.ws) rawSend(t.ws, { action: 'kickedFromLobby' })
        const tws = t.ws
        removePlayer(room, t, 'kicked')
        try { tws?.close(1000, 'kicked') } catch {}
        return
      }
      case 'startGame': {
        room.inGame = true
        const out = { ...m, from: me.id }; delete out.to; delete out.sticky
        const s = JSON.stringify(out)
        room.sticky.set('startGame', s)
        return toAll(room, s, me.id)
      }
      case 'returnToLobby':
        room.inGame = false; room.sticky.clear()
        for (const p of room.players.values()) p.isReady = false
        return toAll(room, { action: 'returnToLobby', from: me.id }, me.id)
    }

    // --- generic relay (game + co-op messages) ---
    const out = { ...m, from: me.id }
    const to = m.to
    delete out.to
    if (!me.isHost) {
      // guests may only talk to the host; the host decides what everyone sees
      const host = room.players.get(room.hostId)
      if (host) deliver(host, out)
      return
    }
    const sticky = m.sticky; delete out.sticky
    const s = JSON.stringify(out)
    if (sticky) {
      const key = typeof sticky === 'string' ? sticky.slice(0, 64) : a
      if (room.sticky.size >= 256 && !room.sticky.has(key)) room.sticky.delete(room.sticky.keys().next().value)
      room.sticky.set(key, s)
    }
    if (to === undefined || to === 'all' || to === 'others') return toAll(room, s, me.id)
    const ids = Array.isArray(to) ? to : [to]
    for (const id of ids) { const p = room.players.get(id); if (p && p.id !== me.id) deliver(p, s) }
  }

  function mkPlayer (username, isHost) {
    return { id: newId(), token: newToken(), username: cleanName(username), isHost, isReady: false, ws: null, outbox: [], outboxOverflow: false, graceTimer: null, joinedAt: Date.now() }
  }

  // ---------- transport ----------
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, rooms: rooms.size, proto: PROTO })) }
    res.writeHead(404); res.end()
  })
  const wss = new WebSocketServer({ noServer: true, maxPayload: cfg.maxPayload, perMessageDeflate: false })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname !== cfg.path) { socket.destroy(); return }
    if (cfg.allowedOrigins && !cfg.allowedOrigins.includes(req.headers.origin)) { socket.destroy(); return }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
  })
  wss.on('connection', (ws) => {
    ws._alive = true
    ws.on('pong', () => { ws._alive = true })
    ws.on('message', (data, isBinary) => {
      ws._alive = true
      if (isBinary) return err(ws, 'bad_message', 'text frames only')
      try { handle(ws, data.toString('utf8')) } catch (e) { cfg.log('handler error', e); err(ws, 'internal', 'server error') }
    })
    ws.on('close', () => onSocketGone(ws))
    ws.on('error', () => {})
    rawSend(ws, { action: 'connected', proto: PROTO, serverTime: Date.now() })
  })
  const hb = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws._alive) { ws.terminate(); continue } // half-open (e.g. iOS suspended) -> grace path
      ws._alive = false
      try { ws.ping() } catch {}
    }
  }, cfg.heartbeatMs)

  const ready = new Promise(resolve => server.listen(cfg.port, cfg.host, () => resolve(server.address().port)))
  return {
    ready, rooms,
    get port () { return server.address()?.port },
    close: () => new Promise(resolve => {
      clearInterval(hb)
      for (const r of [...rooms.values()]) closeRoom(r, 'server_shutdown')
      for (const ws of wss.clients) ws.terminate()
      wss.close(); server.close(() => resolve())
    }),
  }
}

// run directly: `node server.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  const relay = createRelay()
  relay.ready.then(port => console.log(`co-op relay listening on :${port} (ws path /ws, health /healthz)`))
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => relay.close().then(() => process.exit(0)))
}
