# Balatro Multiplayer / Co-op Modding Scene — October 2026

*Researched 2026-10-06. Sources: GitHub API (repo metadata, stars and push dates as of today), shallow clones of every repo listed (networking files read directly), the Thunderstore Balatro package index, Nexus Mods, balatromp.com docs, and DuckDuckGo. "Last commit" is the newest push to any branch unless marked otherwise.*

## TL;DR
- **No official multiplayer exists.** I found nothing from LocalThunk or Playstack beyond older AMA/Reddit threads. Every option is a fan mod.
- The scene is centred on the **Balatro-Multiplayer org** (formerly `V-rtualized/BalatroMultiplayer`, which now redirects there). It ships **versus-only** play over **raw TCP plus newline-delimited JSON** to a Node/TypeScript server. A newer **MultiplayerAPI** library uses **MQTT over TLS (EMQX broker) plus an HTTPS API**. Its Thunderstore listing says it supersedes the legacy mod.
- **The real co-op modes live in forks**: **BalatroMultiplayerExperimental** (active, Sept 2026; Co-op plus Teams, up to 16 players) and **FilPag's coop fork with a Rust server** (Co-op Survival, 6 players; stale since Sept 2025). The older **Balatrogether** (2024, abandoned) has fully mirrored shared-control co-op.
- **Every mod uses luasocket TCP** (`socket.tcp()`), or WebRTC through a native Rust DLL in balatro-vs. A browser can't run either directly, so a love.js port needs a **WebSocket bridge** (for example websockify or a small WS→TCP relay), or a swap to a JS-side WebSocket transport.
- **Recommendation:** use the **BalatroMultiplayerExperimental co-op mode (GPL-3.0) as the design and protocol reference**. Put its client/server model on a **WebSocket transport** with a **self-hosted TypeScript server** (fork its server) that also runs the "beat a blind → generate a Wikipedia Joker via LLM" step.

## 1. Mods catalogue

| Mod | Repo | ★ | Last commit | License | Modes | Deps | Transport / server |
|---|---|---|---|---|---|---|---|
| **Balatro Multiplayer** (BMP) | github.com/Balatro-Multiplayer/BalatroMultiplayer (old `V-rtualized/…` redirects here) | 341 | push 2026-09-10 (dev); release v0.5.5 2026-08-14; Thunderstore 0.5.7 | GPL-3.0 | **Versus only**: Attrition, Showdown, Survival, plus many rulesets (ranked, blitz, sandbox, Major/Minor League…) | SMODS ≥1.0.0~BETA-1620a, Lovely ≥0.9, Balatro ≥1.0.1o | `socket.tcp()` in a `love.thread`, newline-delimited JSON, default `balatro.virtualized.dev:8788`, no TLS |
| BMP server | github.com/Balatro-Multiplayer/BalatroMultiplayerAPI-Server | 13 | 2026-09-27 | GPL-3.0 | 2-player lobbies (host + guest) | Node, `node:net`, better-sqlite3 | TCP :8788 (admin :8789). 5-letter lobby codes. Keep-alive every 5 s |
| **MultiplayerAPI** (MPAPI) | github.com/Balatro-Multiplayer/BalatroMultiplayerAPI | 7 | 2026-09-09; Thunderstore 0.1.2 | GPL-3.0 | Library: lobbies, host metadata, per-player state, actions/broadcast, chat, Steam/Discord auth, 2-min reconnect grace | SMODS ≥1.0.0~BETA-1221a, Lovely ≥0.8 | **MQTT 3/5** (bundled luamqtt) over **TLS via an OpenSSL FFI** to `balatro.virtualized.dev:8883`, HTTPS API on :8788. Backend: Express API + EMQX + Postgres. **I couldn't find the backend source**; the README says self-hosting works via config (`custom_server_url`, plain MQTT :1883) |
| MultiplayerSpeedrun | github.com/Balatro-Multiplayer/BalatroMultiplayerSpeedrun | 1 | 2026-09-09 | GPL-3.0 | Real-time speedrun modes on MPAPI | MPAPI | MQTT (as above) |
| **BalatroMultiplayerExperimental** | github.com/ashraf17m/BalatroMultiplayerExperimental (BMP fork) | 5 | 2026-09-19 (v0.11.3) | GPL-3.0 | Versus, **Teams**, **Co-op**; `max_players` up to 16 | SMODS, Lovely | `socket.tcp()` thread, JSON "protocol v2", default `sakura.proxy.rlwy.net:11054` (Railway TCP proxy) |
| Experimental server | github.com/ashraf17m/BalatroMultiplayerExperimentalAPI-Server | 1 | 2026-09-18 | GPL-3.0 | Co-op boss sync, team blind flow, team state | Node/TS `node:net` | Raw TCP, newline-delimited JSON, no TLS or auth |
| **FilPag coop fork** | github.com/FilPag/BalatroMultiplayer (branch `coop`) + github.com/FilPag/Coop-BalatroMultiplayerServer | 0 / 1 | 2025-09-11 | GPL-3.0 / MIT | **Co-op Survival** (≤6 players), **Clash** (8-player battle royale) | SMODS, Lovely | TCP :8788, **4-byte length-prefixed MessagePack**. Server written in **Rust/Tokio** |
| **Balatrogether** | github.com/Irreflexive/Balatrogether + Balatrogether-Server (C++) | 1 / 1 | 2024-08-19 (one commit, abandoned) | none (all rights reserved) | **Co-op (fully mirrored shared run)** and Versus (elimination "Duel" blinds, PvP jokers) | SMODS 1.0.0-Alpha, Lovely, LuaSec | TCP :7063 with optional TLS (LuaSec). Self-host only |
| **balatro-vs** (DShad) | github.com/Fcornaire/balatro-vs | 4 | 2026-09-18 (v0.6.0; ~11.8k Thunderstore DLs) | GPL-3.0 | **Versus 1v1** first-to-10; random matchmaking + friend codes; Android/Switch | Lovely v0.9, SMODS 26.829.0 | Native **Rust cdylib** (ships as `winmm.dll`): **WebRTC P2P via matchbox_socket** plus WebSocket relay fallback. Lua calls it through mlua |
| MP CO-OP Addon (Nexus #813) | nexusmods.com/balatro/mods/813 | — | v0.2.0, 2026-05-02 | — | Classic / Advanced CO-OP: separate runs, **shared blind score** | BMP ≥0.3.3 | Uses BMP's TCP. **Author marked it deprecated** in favour of Experimental's co-op |
| TropicalFrog3 Coop | github.com/TropicalFrog3/BalatroMultiplayerCoop | 0 | 2025-04-23 ("uncompleted") | none | WIP coop / 2v2 | SMODS, Lovely ≥0.7 | Listen-server: `socket.bind("*",PORT)` inside the game. Unfinished |

Other repos the searches turned up, none relevant here: BMP launcher (TS), Botlatro Discord matchmaking bot, `Balatro-Multiplayer/lovely-injector-with-ssl` (a Lovely fork, 2025), `coslatte/BalatroMultiplayerLAN` (fork, 2026-09-01).

**How BMP lobbies work:** Create Lobby → pick ruleset/gamemode → the server returns a lobby code → share it → the guest joins with the code → both ready up → Start. Both clients play the **same seed locally**. The server is a thin relay plus referee: it stores lives and scores, decides PvP ("Nemesis") blind outcomes, and sends `keepAlive`. It does not simulate the game.

## 2. Which mods are genuinely cooperative?
1. **BalatroMultiplayerExperimental: Co-op (most mature and active).** Players fight normal blinds together. The blind target **scales with the number of active players** (`coop_blind_scaling_per_player = 1`, `curve = 1.4`). The server syncs a shared boss (`coopBossBlindHandlers.ts`). There is optional **team card sync** (`overrides/team_card_sync.lua`) and a Teams mode. It has a 2026 code structure (domain/state accessors, protocol v2 validation, tests). The Nexus co-op author now points people to it. Weaknesses: one maintainer, 5 stars, and its public server is a Railway proxy.
2. **FilPag Co-op Survival.** Each player has their own run, deck and seed. At the boss the server **sums every player's score against one boss chip target** (`get_total_score() > boss_chips`), and **everyone loses a life together** on failure (2 lives, up to 6 players). The idea is clean and simple, but the code has been stale for a year.
3. **MP CO-OP Addon.** Same shared-blind-score idea. Deprecated.
4. **Balatrogether Co-op.** The only *true shared-run* co-op: every pick, purchase and reroll is mirrored. It was abandoned in 2024, targets an alpha SMODS, has no license, and its server is C++.
5. Mainline BMP, MPAPI and balatro-vs are **competitive only**. MPAPI is a generic N-player library, though, so co-op could be built on it.

## 3. Web (love.js / Emscripten) feasibility
Browsers can't open raw TCP or UDP sockets, and love.js's own README lists "Using LuaSocket" as a known limitation. Every mod's networking files confirm a TCP dependency:

| Mod | Networking code (read) | Web path |
|---|---|---|
| BMP | `networking/socket.lua`: `socket.tcp()`, `:connect(url,8788)`, `:receive()` lines, in a `love.thread` | Needs a WS↔TCP bridge (websockify) or a rewritten transport. The JSON-line protocol maps 1:1 onto WebSocket text frames, so it's easy |
| Experimental | `networking/socket_thread_setup.lua`: `socket.tcp()`, plus thread loop and queues | Same; the protocol is equally simple |
| FilPag | `networking/socket.lua`: `socket.tcp()` + `socket.select`, MessagePack, length header | Bridge works (binary WS); a little more work |
| MPAPI | `mqtt_thread.lua`: `socket.tcp()` + **OpenSSL via LuaJIT FFI** + luamqtt | **Worst fit.** love.js has no LuaJIT FFI and no OpenSSL. You'd swap in MQTT-over-WebSockets (EMQX supports it natively) done JS-side |
| balatro-vs | Native Rust DLL (WebRTC / tungstenite) | **Not portable** unless rebuilt for wasm, though WebRTC itself is browser-native |
| Balatrogether | `tcp_thread.lua`: `socket.tcp()` + LuaSec | Bridge + drop TLS (use wss at the proxy) |

Other web blockers:
- love.js threads need pthreads/SharedArrayBuffer, which means COOP/COEP headers. Otherwise use the compatibility build and move networking to the main thread.
- No LuaJIT, so code using `ffi` breaks. In BMP this includes `lib/crypto.lua`'s Windows serial lookup, plus SMODS/nativefs bits.
- `goto` (LuaJIT/5.2) must be removed.
- W0W53R/web-balatro (MIT, 35★) shows SMODS runs on love.js using a Lovely dump plus edits.

**Best web transport:** expose a small JS WebSocket API to Lua, either through an Emscripten `EM_JS`/`love.js` JS-bridge or by polling a JS queue. Or run networking against a WS endpoint and terminate it at a server that also speaks the mod's JSON protocol.

## 4. Steamodded and Lovely status
- **Steamodded (github.com/Steamodded/smods, 983★, GPL-3.0):** has switched to date versioning. Latest is **26.1002.0 (2026-10-02)**; the previous was 26.829.0. The final old-scheme build was 1.0.0-beta-1814a (2026-06-14).
- **Lovely injector (github.com/ethangreen-dev/lovely-injector, 609★, MIT):** latest is **v0.10.0 (2026-09-23)**. The Windows DLL was renamed `version.dll` → **`winmm.dll`**. Builds exist for Windows, macOS (arm/x86) and Linux.
- **Can Lovely patches be applied ahead of time? Yes.**
  - Lovely only hooks `luaL_loadbufferx` and rewrites each chunk's source text using pattern, regex, copy and module patches from `Mods/*/lovely/*.toml` (`lovely-core/src/lib.rs: apply_buffer_patches`). The patching is pure text transformation on Lua source.
  - It writes every patched file to `Mods/lovely/dump`, and `--dump-all` dumps even unpatched files.
  - So the practical pipeline is: run the game once natively with Lovely (or run `lovely-core`'s patch engine as a CLI/wasm build step), then ship the dumped, pre-patched Lua inside the `.love` for love.js. No DLL injection is needed at runtime.
  - web-balatro's "Use Lovely Dump" already does this. It also has a JS re-implementation of the TOML patcher, which has a known multiline `''''` quirk.
  - Caveat: patches that reference SMODS sources (`=[SMODS _ "src/..."]`) have to be applied after SMODS is in the bundle. Re-dump whenever mods change.

## 5. Recommendation for this project
**Base the co-op mode on BalatroMultiplayerExperimental's Co-op design. Fork its TypeScript server, and use FilPag's "sum scores vs. a shared boss target, shared lives" rule as the simplest MVP. Replace the TCP transport with WebSockets.**

Why:
- **It's genuinely cooperative, current (Sept 2026) and GPL-3.0.** Shared blinds, per-player scaling, shared boss sync and team card sync map directly onto "the team beats a blind → reward."
- **The protocol is simple newline JSON.** It translates trivially to WebSocket frames. Node's `ws` can host it beside the existing `node:net` listener, so native and web clients can share lobbies.
- **The server is TypeScript and self-hostable.** It's the natural place to add an authoritative "blind cleared → call the LLM agent → fetch the Wikipedia topic → return a validated Joker spec (name, rarity, effect from a whitelisted effect DSL, art prompt)" step. It then broadcasts the new Joker to every client, so all clients register the same SMODS.Joker deterministically. Keep LLM keys server-side.
- **The alternatives fit worse.** MPAPI is the official future, but its MQTT + OpenSSL-FFI stack is the hardest to port to love.js, and the backend source isn't public. Balatrogether's fully mirrored co-op is attractive but unlicensed and dead. balatro-vs is native-DLL and versus-only.
- **The cost:** strip the competitive rulesets you don't need, remove `ffi` uses, pre-apply Lovely patches via a dump, and make sure every client agrees on joker-gen results (server-authoritative, keyed by lobby and ante). Respect GPL-3.0 if you distribute the modified mod. Never ship Balatro's own source; users supply their own game files.
