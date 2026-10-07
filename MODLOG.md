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
