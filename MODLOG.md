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
