// End-to-end test: relay + 3 simulated clients (host + 2 guests) + a late joiner.
// Run: node test.js   (exit code 0 = all passed)
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { createRelay } from './server.js'

const relay = createRelay({ port: 0, host: '127.0.0.1', graceMs: 1500, heartbeatMs: 60_000, log: () => {} })
const port = await relay.ready
const URL_ = `ws://127.0.0.1:${port}/ws`
let passed = 0
const step = async (name, fn) => { const t = Date.now(); await fn(); passed++; console.log(`  ok ${passed} - ${name} (${Date.now() - t} ms)`) }

class Sim {
  constructor (name) { this.name = name; this.inbox = []; this.waiters = [] }
  open () {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(URL_)
      this.ws.on('message', d => {
        const m = JSON.parse(d.toString())
        this.inbox.push(m)
        for (const w of [...this.waiters]) if (w.pred(m)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(m) }
      })
      this.ws.once('error', reject)
      this.next('connected').then(resolve)
    })
  }
  send (m) { this.ws.send(JSON.stringify(m)) }
  // resolve with the first already-received-or-future message matching
  next (action, pred = () => true, ms = 4000) {
    const f = m => m.action === action && pred(m)
    const i = this.inbox.findIndex(f)
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0])
    return new Promise((resolve, reject) => {
      const w = { pred: f, resolve: m => { clearTimeout(t); this.inbox.splice(this.inbox.indexOf(m), 1); resolve(m) } }
      const t = setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); reject(new Error(`${this.name}: timeout waiting for ${action}`)) }, ms)
      this.waiters.push(w)
    })
  }
  async none (action, ms = 300) {
    await new Promise(r => setTimeout(r, ms))
    assert.ok(!this.inbox.some(m => m.action === action), `${this.name} unexpectedly got ${action}`)
  }
  close () { try { this.ws.terminate() } catch {} }
}

const host = new Sim('host'), g1 = new Sim('alice'), g2 = new Sim('bob'), g3 = new Sim('late')
let code, hostId, g1Id, g2Id, g2Token
console.log(`relay on :${port}`)

try {
  await step('host creates co-op lobby', async () => {
    await host.open()
    host.send({ action: 'createLobby', gameMode: 'coop', username: 'Host', options: { starting_lives: 2, coop_blind_scaling_per_player: 1, coop_blind_scaling_curve: 1.4 } })
    const j = await host.next('joinedLobby')
    assert.match(j.code, /^[A-HJ-NP-Z]{5}$/); assert.equal(j.isHost, true); assert.ok(j.reconnectToken)
    code = j.code; hostId = j.playerId
  })

  await step('two guests join by code; everyone sees roster', async () => {
    await g1.open(); await g2.open()
    g1.send({ action: 'joinLobby', code: code.toLowerCase(), username: 'Alice' })
    const j1 = await g1.next('joinedLobby'); g1Id = j1.playerId
    assert.equal(j1.isHost, false); assert.equal(j1.hostId, hostId)
    g2.send({ action: 'joinLobby', code, username: 'Bob<script>' })
    const j2 = await g2.next('joinedLobby'); g2Id = j2.playerId; g2Token = j2.reconnectToken
    assert.equal(j2.players.length, 3)
    assert.equal(j2.players.find(p => p.id === g2Id).username, 'Bobscript')
    await host.next('lobbyPlayerJoined', m => m.player.id === g1Id)
    await host.next('lobbyPlayerJoined', m => m.player.id === g2Id)
    await g1.next('lobbyPlayerJoined', m => m.player.id === g2Id)
  })

  await step('bad code rejected', async () => {
    const x = new Sim('x'); await x.open()
    x.send({ action: 'joinLobby', code: 'ZZZZZ' })
    const e = await x.next('error'); assert.equal(e.code, 'room_not_found'); x.close()
  })

  await step('ready flags broadcast', async () => {
    g1.send({ action: 'readyLobby' }); g2.send({ action: 'readyLobby' })
    await host.next('lobbyPlayerUpdated', m => m.player.id === g1Id && m.player.isReady)
    await host.next('lobbyPlayerUpdated', m => m.player.id === g2Id && m.player.isReady)
  })

  await step('guest cannot start game (host-only)', async () => {
    g1.send({ action: 'startGame', seed: 'HACK' })
    const e = await g1.next('error'); assert.equal(e.code, 'not_host')
    await g2.none('startGame', 150)
  })

  await step('host starts with shared seed → all guests', async () => {
    host.send({ action: 'startGame', seed: 'ABC12345', deck: 'b_red', stake: 1, lives: 2 })
    for (const g of [g1, g2]) {
      const s = await g.next('startGame')
      assert.equal(s.seed, 'ABC12345'); assert.equal(s.from, hostId)
    }
  })

  await step('guest messages go only to host, `to`/`from` cannot be spoofed', async () => {
    g1.send({ action: 'playHand', score: '12345', handsLeft: 2, to: g2Id, from: 'FAKE' })
    const p = await host.next('playHand'); assert.equal(p.from, g1Id); assert.equal(p.score, '12345')
    await g2.none('playHand')
  })

  await step('card_request: guest → host only', async () => {
    g2.send({ action: 'card_request', reqId: 'r1', topic: 'https://en.wikipedia.org/wiki/Ada_Lovelace' })
    const r = await host.next('card_request'); assert.equal(r.from, g2Id); assert.equal(r.reqId, 'r1')
    const ack = host.inbox.find(m => m.action === 'card_request'); assert.equal(ack, undefined)
    await g1.none('card_request')
  })

  await step('card_granted: host → all guests (sticky)', async () => {
    const card = { id: 'wj_ada_lovelace', name: 'Ada Lovelace', rarity: 2, cost: 6, effect: { kind: 'mult_per_hand_type', hand: 'Straight', mult: 8 } }
    host.send({ action: 'card_granted', reqId: 'r1', requester: g2Id, card, sticky: 'card:wj_ada_lovelace' })
    for (const g of [g1, g2]) { const c = await g.next('card_granted'); assert.deepEqual(c.card, card); assert.equal(c.from, hostId); assert.equal(c.sticky, undefined) }
  })

  await step('host direct message to one guest', async () => {
    host.send({ action: 'card_rejected', reqId: 'r2', reason: 'busy', to: g1Id })
    const r = await g1.next('card_rejected'); assert.equal(r.reason, 'busy')
    await g2.none('card_rejected')
  })

  await step('API-key-looking payload refused, never relayed', async () => {
    g1.send({ action: 'chat', text: 'my key sk-or-v1-0123456789abcdef0123456789abcdef' })
    const e = await g1.next('error'); assert.equal(e.code, 'secret_detected')
    await host.none('chat')
  })

  await step('host-computed blind result + shared lives broadcast', async () => {
    host.send({ action: 'endCoopBlind', lost: true, teamScore: '900', target: '1200' })
    host.send({ action: 'playerInfo', lives: 1, lifeLossReason: 'team_coop_blind_failed', previousLives: 2 })
    for (const g of [g1, g2]) { await g.next('endCoopBlind', m => m.lost === true); const l = await g.next('playerInfo'); assert.equal(l.lives, 1) }
  })

  await step('keepAlive → keepAliveAck', async () => {
    g1.send({ action: 'keepAlive', t: 42 }); const a = await g1.next('keepAliveAck'); assert.equal(a.t, 42)
  })

  await step('iOS-style background drop: seat held, outbox replayed on rejoin', async () => {
    g2.close()
    await host.next('lobbyPlayerUpdated', m => m.player.id === g2Id && !m.player.connected)
    host.send({ action: 'coopBossBlind', phase: 'start', ante: 2, bossKey: 'bl_wall', revision: 1 })
    await g1.next('coopBossBlind')
    const g2b = new Sim('bob-again'); await g2b.open()
    g2b.send({ action: 'rejoinLobby', code, reconnectToken: g2Token })
    const rj = await g2b.next('rejoinedLobby'); assert.equal(rj.playerId, g2Id); assert.equal(rj.isInGame, true)
    const b = await g2b.next('coopBossBlind'); assert.equal(b.bossKey, 'bl_wall')
    await host.next('lobbyPlayerUpdated', m => m.player.id === g2Id && m.player.connected)
    g2.ws = g2b.ws; g2.inbox = g2b.inbox; g2.waiters = g2b.waiters; g2.close = () => g2b.close()
  })

  await step('rejoin with bad token fails', async () => {
    const x = new Sim('x'); await x.open()
    x.send({ action: 'rejoinLobby', code, reconnectToken: 'nope' })
    assert.equal((await x.next('error')).code, 'rejoin_failed'); x.close()
  })

  await step('late joiner gets startGame + granted cards replayed', async () => {
    await g3.open(); g3.send({ action: 'joinLobby', code, username: 'Late' })
    const j = await g3.next('joinedLobby'); assert.equal(j.isInGame, true)
    assert.equal((await g3.next('startGame')).seed, 'ABC12345')
    assert.equal((await g3.next('card_granted')).card.id, 'wj_ada_lovelace')
  })

  await step('grace expiry removes a vanished guest', async () => {
    g3.close()
    const left = await host.next('lobbyPlayerLeft', m => m.reason === 'timeout', 4000)
    assert.ok(left.playerId)
  })

  await step('host leaves → room closed gracefully for guests (no migration)', async () => {
    host.send({ action: 'leaveLobby' })
    for (const g of [g1, g2]) { const c = await g.next('lobbyClosed'); assert.equal(c.reason, 'host_left') }
    assert.equal(relay.rooms.size, 0)
  })

  console.log(`\nPASS ${passed} steps`)
} catch (e) {
  console.error(`\nFAIL after ${passed} steps:`, e)
  process.exitCode = 1
} finally {
  for (const s of [host, g1, g2, g3]) s.close()
  await relay.close()
}
