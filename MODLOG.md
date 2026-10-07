# Balatro → web (MODLOG)

## 2026-10-06 — first boot ✅
- **Source:** the user's own Steam copy on desktop-3rsf4r5 at `D:\SSD Games\Steam\steamapps\common\Balatro\Balatro.exe` (build 17459173, version 1.0.1o-FULL, no mods/Lovely installed). Copied to `input/` with ssh `cat`, md5 `0b970613aa75561c15a3f6596c179275` verified (the scp path form fails on that host).
- **Format:** a fused LÖVE exe with game.love appended as a zip at offset 394752 (Python zipfile can read it; busybox unzip can't, "short read"). The zip holds 304 entries.
- **Route:** love.js (npm 11.4.1, Davidobot) plus our own patch set. Runs single-threaded ("compat"). **It boots to the animated splash with the shaders working in the foreground Minis preview** (user confirmed with a screenshot). It's laggy, and the layout needs fixing.
- **Patches** (`tools/patch_love.py` and `src/patches/web_shim.lua`, all exact-match replacements that fail loudly):
  - `bit` polyfill, a `jit` stub, `math.log(x,base)` and a fix for float `randomseed`.
  - love.thread replaced by coroutines.
  - The Steam check skipped; the sound thread turned off.
  - Mipmaps dropped; a constant loop bound in hologram.fs.
  - Saves now trigger an IDBFS `syncfs(false)` flush, also on pagehide/hidden.
  - The error handler no longer blocks.
- **Dev loop:**
  - `sh tools/build_dev.sh` takes about 1 minute.
  - `tools/dev_server.py` gives the page log beacon `/__log` plus page commands through `/__cmd` (`shot`, `eval`).
  - Open the page with `minis-open http://127.0.0.1:8765/p-compat/t.html?v=N`. **The browser_use tab is hidden and throttled (0 rAF frames), so love.js never starts there. Always test in the foreground preview.**
  - Start the server with `setsid nohup … </dev/null &`. Otherwise it dies when the shell exits.
- **Known issues:**
  - The splash runs at about 12–20 fps (LONG DT 50–80 ms).
  - The canvas is portrait and fills the page; there's no landscape or fit yet.
  - `shot` returns a white canvas, so it needs preserveDrawingBuffer or a capture hook inside Emscripten's own rAF.
  - Audio is untested.
- **Next:** test the threaded build and a LÖVE 11.5 runtime built with a newer Emscripten (alexjgriffith update-lovejs, Emscripten 5, wasm exceptions). Add a landscape shell with the canvas sized to the viewport and DPR capped. Profile CRT on/off.

## 2026-10-06 (later) — v2 shell, LÖVE 11.5, published ✅
- **New runtime:** alexjgriffith/update-lovejs 11.5 `compat` (Emscripten 5.0.6, wasm exceptions) vendored into `web/runtime/`. **One upstream fix:** `doRun` must wait for run dependencies, otherwise the IDBFS save store (added after `run()`) aborts startup — see `web/runtime/PATCHES.txt`.
- **LÖVE 11.4 → 11.5 was a big win** and the 11.5 runtime persists saves itself (`autoPersist`).
- **New shell `web/`:** file picker → in-browser patching (`patches/balatro-1.0.1.json`, injected `web_shim.lua`) → directory-mode MEMFS game → full-screen canvas. Game stays in IndexedDB; re-patched at every launch, so patch updates apply without re-picking the file.
- **Display fix (the portrait/letterbox bug):** emscripten reports the physical screen (always portrait on iPhone), so `love.window.getDesktopDimensions`/`getFullscreenModes`/`updateMode` are overridden with the real CSS viewport, pushed from the page on boot, resize and rotation. Live rotation confirmed working (880×1572 → 1664×684 @2x).
- **Perf:** main menu holds **60 fps** at 2× on iPhone 17 Pro Max. Remaining dip: the intro splash, 10–20 fps for ~4 s (asset decode, shader compiles, GC), plus a 59 ms frame during a screenshot encode.
- **Dev loop:** `tools/dev_server.py` now serves the shell with COOP/COEP, a log beacon, targeted commands (`/__cmd?to=<tag>`: `play`, `tap`, `shot`, `lua <code>`) and `/__devgame` (the developer's own copy). Old preview tabs also poll the queue, so commands must be tagged — that bug cost a debugging round.
- **Published:** https://github.com/collinsomniac/balatro-web (public) → https://collinsomniac.github.io/balatro-web/ , deployed by `.github/workflows/pages.yml`. `um publish check` clean; a scripted scan confirms no long verbatim game lines in `web/`.
- **Not done:** audio untested; touch tuning (`MIN_CLICK_DIST` raised to 2.5, unverified); the intro splash optimisation; co-op server (prototype files exist in `server/` from a sub agent that ran out of budget without a design write-up); the Wikipedia card-generation agent (sub agent ran out of budget — needs re-delegation).


## 2026-10-06 (night) — usability, crash fix, measurement
- **Crash found and fixed (from the owner's video):** the shell used to hand back to the "Tap to play" screen while the engine kept running, so tapping again started a *second* engine and iOS killed the page. Now: one engine only (`started` guard), the loader goes straight into the game, and an in-game ☰ button returns to the menu.
- **"From my computer" flow:** the desktop runs `D:\balatro-web\serve.py` (read-only, CORS, manifest of findable game files) exposed over Tailscale HTTPS by `tailscale serve --bg --https=443 http://127.0.0.1:8770`. A logon task `BalatroWebServe` restarts it. Verified end-to-end from the phone: the published site found `Balatro.exe`, downloaded 53.8 MB over the tailnet, patched it in-browser (1.2 s) and reached "Tap to play".
- **Loading screen:** staged progress (engine download with real bytes, patching, engine start, asset load) plus a "Details" log.
- **Optimisations applied:** skip-intro (menu in ~1.5 s), frame cap 60, quality selector 1×–3×, engine downloaded once and passed to the runtime (no double fetch), archive freed as files are written to MEMFS, viewport updates made idempotent (repeated `updateMode` was making the game rebuild canvases every frame — 19 fps → 55 fps), single engine instance.
- **Measured (iPhone 17 Pro Max):** menu 54–55 fps at 2× (1664×684), 57–60 fps at 1×; Lua heap ~4.6 MB; wasm over the wire 2.1 MB compressed.
- **Lua 5.4 vs 5.1 (same Emscripten):** 3M-iteration loop 35 ms (5.4) vs 22 ms (5.1); math loop 8 ms vs 10 ms. Net: keep 5.1. Lua 5.4 would also risk `string.format('%d', float)` errors.
- **Audio:** `love.audio` present, 9 sources playing, volume 50/100/100, 80 sound files, not muted — i.e. the game's side works. The page's AudioContext reported `interrupted` because the preview had no genuine gesture (and the phone's audio session was held by the recorder). Added the iOS unlock (silent buffer inside the first real tap). Needs a check with a real tap.
- **Next big lever:** stop unzipping the whole 53 MB archive in JS at every launch — store the original `.love`/exe-zip in MEMFS as the game source, extract only the ~8 patched files, and mount that as an overlay archive (`love.filesystem.mount`). Saves ~1 s of startup and a large slice of memory. After that: real threads (pthreads build + COOP/COEP headers) to move save compression off the main thread, which is the likely cause of the remaining in-game hitches.


## 2026-10-06 (late) — freeze diagnosed and fixed
Symptoms: engine started, Balatro's own loading bar showed, then the frame froze (page rAF still 120 fps, no Lua ticks).
Two independent causes, both mine:
1. **Stale engine from the service worker.** Its cache name never changed and `.wasm` was cache-first, so a brief
   experiment with a Lua 5.4 runtime left Safari using that wasm together with the new loader — a mismatched pair.
   Fixed: the SW is now network-first for everything (cache only as an offline fallback) and the cache version is bumped.
2. **A resize loop.** The shell nudged `love.window.updateMode` whenever the viewport changed, and Safari's
   collapsing toolbar changes it constantly, so the game rebuilt its canvases endlessly and froze on the last frame.
   Fixed: the browser owns the canvas size (SDL already resizes it and fires `love.resize`, which the game handles);
   the shim now only records the viewport, with a single throttled nudge 3 s after boot if the size is genuinely wrong,
   and never calls `love.resize` by hand. Canvas CSS uses `100vh`, not `100dvh`, so the toolbar cannot retrigger it.
Also added: error banner, live state chip, "Copy details" diagnostics, "show the game anyway" after 12 s, and a
25 s engine-silence watchdog.
