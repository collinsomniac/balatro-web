# Balatro in the browser (Safari on iPhone) via love.js: research

Researched 2026-10-06 using the GitHub API, the npm registry, the binaries themselves, and web search. Claims I checked against code or binaries are marked **[verified]**. Inferences are marked **[inferred]**.

## 1. Which LÖVE version Balatro targets
- **LÖVE 11.5.** Balatro's own `conf.lua` does **not** set `t.version`. It only sets the title, `window.width/height = 0` and `minwidth/minheight = 100` (copy of 1.0.1o: `balatro-src/balatro-src-reverse-engineering/conf.lua`) [verified]. So the version comes from community evidence:
  - balatro-mobile-maker wraps the game in `love-11.5-android-embed.apk` (`Constants.cs`) [verified].
  - The PortMaster port's conf sets `t.version = '11.5'` [verified].
  - nixpkgs runs `Balatro.exe` 1.0.1o on stock `love` [verified].
  - Balatro shipped in February 2024. LÖVE 11.5 was released 2023-12-03 [verified, GitHub releases].
  - To confirm on our own copy, check the version resource of `love.dll` next to `Balatro.exe`.
- **The engine is LuaJIT-dependent in small ways.** `main.lua` has `require "bit"` and calls `jit.arch`/`jit.off()` on macOS. `misc_functions.lua` uses `bit.bxor/lshift/rshift` [verified]. love.js uses **PUC Lua 5.1 with no JIT** (`-DLOVE_JIT=0`), so `bit` and `jit` need shims.
- **Threads.** `game.lua` starts `love.thread` workers: `engine/sound_manager.lua` (when `G.F_SOUND_THREAD`), `engine/save_manager.lua` (always, blocks on `CHANNEL:demand()`), and `http_manager.lua` (only if `F_HTTP_SCORES`) [verified].
- **Steam.** `love.load` does `require 'luasteam'` and **quits if `st:init()` fails** when `getOS()` is `'Windows'` or `'OS X'` [verified].
- The PC source already has an `F_MOBILE_UI` flag in `globals.lua`. It defaults to false.

## 2. love.js runtimes
| Runtime | LÖVE | Status | Notes |
|---|---|---|---|
| **Davidobot/love.js** (848★) | 11.5 in repo `src/` (strings in the `love.wasm` binary show 11.5) [verified] | Last commit 2024-05-13. Built with Emscripten **2.0.0** | Has a `release` build (pthreads, needs SharedArrayBuffer and COOP/COEP) and a `compat` build (`-c`, no pthreads; the README warns of "dodgy audio"). Graphics are WebGL1 / GLSL ES 1.00 (`FULL_ES2=1`). Saves: IDBFS at `/home/web_user/love`, loaded on start and **written back only on `beforeunload`** (`EmscriptenPersistence.js`) [verified]. Open issues include Safari arrow keys (#114), `love.audio.play` crash (#106), `FS errno 28` / out-of-bounds memory (#110, #47), `setWrap("repeat")` ignored (#101), and an unmerged PR #112 (newer Emscripten plus mobile keyboard). |
| **npm `love.js`** | **11.4.1, the latest on npm** (2022-08-25); its wasm reports 11.4 [verified] | Not republished since. The repo's 11.5 binaries are **not** on npm | `npx love.js game.love out -c -t Title -m <bytes>`. `-m` must be at least the asset size. Its `game.js` uses `Module.getMemory` (Emscripten 2.0.0 only). For 11.5, run `node index.js` from a git clone instead of using npm. |
| **2dengine/love.js** (188★) | 11.5 (`11.5/love.wasm`, 4.7 MB) [verified] | Active, synced 2026-08-11 | A no-build player: `player.js?g=game.love`. `love.js` contains no `SharedArrayBuffer`, so it is a single-threaded build [verified]. Caches packages in IndexedDB and uses IDBFS. Initial memory is `min(4×pkg+20 MB, deviceMemory)`. Adds `lua/normalize*.lua` shims (`love.js.eval`, safe `filesystem.read`). Supports `love.event.push('quit','reload')`. Known limits from its README: no LuaJIT so slower, audio before a user gesture, clipboard, LuaSocket. **W0W53R/web-balatro is built on this runtime.** |
| **alexjgriffith/update-lovejs** | 11.5 (plus a Lua 5.4 variant) | Active. Release `115-beta2.3` on 2026-05-12, Emscripten **5.0.6**, `-fwasm-exceptions` [verified] | Prebuilt zips: `love115-{release,compat}[-single][-lua54]`. Saves go to `/home/web_user/savedir/`. Adds `web.sqlite`. The newest toolchain available, and the best base if we need to rebuild. |
| TannerRogalsky/love.js | 0.10/11.1-era | Dead (2020) | Historical only. |

- **LÖVE 12:** I found no maintained Emscripten build. alexjgriffith/love has a `12.0-development` branch, but there are no release artifacts. Upstream LÖVE has no official web target.
- **Shaders:** GLSL ES 1.00 has no implicit int↔float conversion (`2` must be `2.0`), needs `precision` qualifiers, and its loops need constant bounds.
- **love.thread:** works in the pthread builds. In the compat build Balatro's threads are not usable, and every Balatro port replaces them with coroutines (see §3).

## 3. Existing Balatro-in-browser attempts
**W0W53R/web-balatro** (MIT, 35★, Pages at w0w53r.github.io/web-balatro) is the reference implementation, and it uses bring-your-own-data. The user picks `Balatro.exe`. JS scans for `PK\x03\x04`, opens the zip with JSZip, applies patches, re-zips it, and caches it in IndexedDB. Then it runs it on 2dengine's 11.5 runtime with `INITIAL_MEMORY = 256 MB` and `FS_createDataFile('/','game.love')` [verified, `build.js`, `runVersion.js`]. Its patches [verified, `patches.js`]:
- `main.lua`:
  - prepend `require "web_patches"`;
  - change `if os == 'OS X' or os == 'Windows'` to `if false` (skips **luasteam**);
  - stub `G.SOUND_MANAGER.channel.push`.
- `globals.lua`: set `F_SOUND_THREAD = false`. Sound then runs on the main thread.
- `resources/shaders/hologram.fs`: change `glow_samples` to the constant `4`. GLSL ES needs constant loop bounds.
- Adds a pure-Lua `bit.lua` (LuaBitOp/bit32 polyfill).
- `web_patches.lua`:
  - `love.system.getOS = 'Windows'`;
  - `string.format` wrapped in pcall;
  - **mipmaps disabled** in `love.graphics.newImage` and `setMipmapFilter` made a no-op (WebGL1 needs power-of-two sizes for mipmaps);
  - `math.randomseed` fixed for non-integer seeds. PUC Lua truncates them, so every unseeded run was identical (issue #4);
  - `math.log(x, base)` emulated (Lua 5.1 has no base argument);
  - `love.thread.newThread`/`getChannel` replaced with **coroutine-based FakeThread/FakeChannel**, so `save_manager` runs as a coroutine resumed on `push`;
  - `load = loadstring`.
- Fake `nativefs` for mods, and a partial Lovely `.toml` patcher. SMODS mostly fails because of `goto` and other LuaJIT-only features.

What is still broken:
- **Saves are unreliable** (issues #3, #6, #9, #15).
- Seeded runs don't match native ones, because the RNG differs.
- There are colour or shader glitches on some GPUs.
- Changing the language errors (#18).

**I found a save bug:** the shipped runtime adds `setInterval(() => FS.syncfs(true, …), 10000)`. `true` means *populate from IndexedDB*, so every 10 s it re-reads the database instead of writing to it. The only real flush is `beforeunload`, and iOS Safari often doesn't fire that [verified, `run/11.5/love.min.js`]. The fix is `FS.syncfs(false, …)`, called after each save request and on `visibilitychange`/`pagehide`.

**ytrewq000/Balatro-Web-Port** (2026) is the same idea with mods.
- Changes: a `bit` polyfill, a seed built from `love.timer.getTime()`, `MIN_CLICK_DIST` 0.9 → 2.5 for click jitter, and silenced debug prints because they cause frame spikes.
- Its HTML adds an **audio-unlock overlay** that resumes `Module.SDL2.audioContext` and `AL.currentCtx.audioCtx` on the first tap.
- It builds with `love.js -c` and memory of at least 1 GB, and reports that Firefox rarely works [verified].
- Note that it **commits the game's source**, which we must not do.

Other repos with that name are JS clones or recreations, not the real game.

## 4. Mobile facts
- **Official mobile release:** Balatro (premium) and Balatro+ (Apple Arcade) launched on iOS and Android on **2024-09-26**, from Playstack (Apple Newsroom 2024-09-05; AppleInsider and TouchArcade). That port is not ours to use. Mobile-maker and web ports start from the PC build.
- **blake502/balatro-mobile-maker** (1.76k★, last push 2024-11) patches the PC `game.love` and injects it into LÖVE 11.5 Android, or into a base IPA for iOS [verified, `Patching.cs`]:
  - `globals.lua`: replace the `loadstring` line with an Android/iOS flag block (`F_SAVE_TIMER=5`, `F_NO_ACHIEVEMENTS`, `F_SOUND_THREAD=true`, `F_VIDEO_SETTINGS=false`, `F_QUIT_BUTTON=false`, `F_CRASH_REPORTS=false`).
  - On-screen keyboard: `text_input_hook` also accepts `HID.touch`.
  - **Flame shader fix**: add `precision MY_HIGHP_OR_MEDIUMP float` and `mediump` parameters to `flame.fs`.
  - Optional: FPS cap (`G.FPS_CAP`, defaulting to the refresh rate).
  - Optional landscape lock (`resizable = false` on mobile).
  - Optional **High DPI** (`t.window.usedpiscale=false` and `highdpi=true`, recommended for iOS).
  - Optional **CRT shader disable** (`crt = 0` and remove `G.SHADERS['CRT']`), needed on Pixel and some other GPUs.
- **Touch input:** Balatro already handles touch in its own code. `love.mousepressed(x,y,button,touch)` sets the `'touch'` input-device flag, and `love.run` maps `touchpressed` to `mousepressed` [verified]. LÖVE turns touches into mouse events, so basic play works in love.js without new code.

## 5. Building with GitHub Actions
- **Prebuilt (simplest):** `actions/setup-node` → `npm i love.js` → `npx love.js -c -t Title game.love web` → `actions/upload-pages-artifact` → `deploy-pages`. Live examples: `htruccoUCSC/Love2DTest/.github/workflows/deploy-lovejs.yml` and `mpwsh/strafox`; 12 repos use this pattern [verified]. **The npm package gives LÖVE 11.4.** For 11.5, `git clone Davidobot/love.js && node index.js -c …`, or just drop in the 2dengine or alexjgriffith binaries; no compile step is needed.
- **From source:** clone `alexjgriffith/update-lovejs --recursive` (submodules: emsdk, love fork, megasource fork). Then run `make setup && make compile-all`; this is `emcmake cmake <megasource> -DLOVE_JIT=0 -DLOVEJS_COMPAT=1 … -fwasm-exceptions` followed by `emmake make`. It runs on `ubuntu-latest`. The submodule URLs are `git@`, so rewrite them to https in CI. Davidobot's version needs emsdk **2.0.0** exactly.
- **For Balatro the workflow must never contain the game.** It builds and publishes only the runtime plus our loader and patches.

## 6. Bring-your-own-data loader
1. `<input type=file accept=".exe,.love,.zip">`, then `file.arrayBuffer()`.
2. Find the zip.
   - Robust way: search the last 64 KB for the EOCD signature `PK\x05\x06`. Read the central-directory size and offset. The real start is `eocdPos − cdSize − cdOffset` (the fused exe's zip offsets are relative to the zip).
   - Fallback: web-balatro's `PK\x03\x04` scan.
   - Slice it out, then parse with fflate or JSZip.
   - A `.love` file starts at byte 0.
3. Apply the patches from §3 and §4 in JS as string replacements. Ship them as a versioned patch set keyed by `version.jkr` (`1.0.1o`). Re-zip with STORE (no compression) to save CPU, or just write the files individually.
4. Cache the patched blob in IndexedDB or OPFS. Then, in `Module.preRun`, call `FS.createDataFile('/', 'game.love', bytes)` and set `Module.arguments = ['game.love']`. Alternatively, mount a directory with `FS.mkdirTree` and pass the folder.
5. Saves:
   - Mount IDBFS at the save directory.
   - Call `FS.syncfs(false)` after each save request, on `visibilitychange→hidden` and on `pagehide`. Optionally also on a timer.
   - Offer export/import of `settings.jkr` and `1/…` as a zip, which is how saves move to and from Steam.
6. Publish only HTML, JS, the love.js wasm, patches and the service worker. Run `um publish check`.

## 7. WebKit / iOS issues
- **SharedArrayBuffer** needs COOP/COEP. GitHub Pages can't set those headers, `coi-serviceworker` doesn't run in the Minis in-app browser, and Safari restarts the page on the first load. **Use the single-threaded compat build.** Balatro doesn't need threads once the patches above are in.
- **Audio:** WebKit keeps every AudioContext suspended until a user gesture. Use a "Tap to start" screen that creates or resumes the OpenAL/SDL contexts. The context also suspends on backgrounding, so resume it on `visibilitychange`. The compat build has known audio glitches. Balatro streams its `.ogg` music, and WebKit has supported Ogg Vorbis decoding since about Safari 15, so it should work [inferred]. Fallback: transcode to AAC at load time.
- **WebGL:** love.js uses WebGL1 / GLSL ES 1.00 with strict typing. We need the hologram loop-bound fix, the flame precision fix, and mipmaps off. Consider disabling CRT by default. iOS can lose the GL context after backgrounding under memory pressure, which needs a reload.
- **Memory:** this device's practical limit is about 1 GB per tab, and jetsam kills the tab silently. Choose `INITIAL_MEMORY` around 256–384 MB with `ALLOW_MEMORY_GROWTH`, as in web-balatro. Avoid ytrewq000's 1 GB minimum. Free the JS copy of the archive after writing it to MEMFS. The game files are tens of MB, and web-balatro's portable bundle is 150 MB [verified README].
- **Input and display:**
  - Safari has had arrow-key bugs (#114), which only matter with a hardware keyboard.
  - There is no Fullscreen API on iPhone. Use a Home Screen web app, landscape, `viewport-fit=cover` and safe areas.
  - Size the canvas to `innerWidth×innerHeight×devicePixelRatio`, with a cap of 2× to save GPU.
  - Use `touch-action:none` on the canvas.
  - Balatro already handles the conversion from touch input to mouse events.
- **Performance:** Lua runs interpreted in wasm, with no JIT. The A19's wasm speed should be enough [inferred]. Cap FPS at 60 and disable the CRT shader if frame time is high.

## Recommended build plan
1. **Runtime:** start with **2dengine/love.js 11.5** (single-threaded, proven with Balatro by web-balatro). Keep **alexjgriffith `love115-compat-beta2.3`** (Emscripten 5) as plan B. Vendor the binaries into `web/runtime/`. Don't use the npm `love.js` package (it is 11.4).
2. **Loader** (`web/loader.js`): file picker, EOCD-based zip extraction with fflate, cached in IndexedDB. Nothing copyrighted is ever fetched from or committed to the server.
3. **Patch set** (`web/patches/1.0.1o.js`):
   - from web-balatro: Steam off, sound thread off, coroutine threads, `bit.lua`, `getOS`, randomseed/`math.log`, mipmaps off, hologram loop;
   - from mobile-maker: flame precision, touch keyboard, highdpi, FPS cap, optional CRT off;
   - plus `MIN_CLICK_DIST` 2.5 for touch.
4. **Saves:** IDBFS with `syncfs(false)` on save, on `pagehide` and on `visibilitychange` (fixing web-balatro's bug), plus `navigator.storage.persist()` and zip export/import.
5. **Shell:** "Tap to play" gesture to unlock audio, landscape and safe areas, DPR capped at 2, wake lock, and a PWA manifest with a service worker for offline play.
6. **Test:** use the local COI server and the Minis browser. Check `window.__game` hooks, the console and screenshots, play one Ante, then reload and confirm the save persists. After that, confirm in Safari as a Home Screen app.
7. **Deploy:** a GitHub Actions workflow that only copies `web/` to Pages. Add an Emscripten rebuild job (update-lovejs) only if runtime bugs require it.

## Sources
- github.com/W0W53R/web-balatro (`build.js`, `patches.js`, `runVersion.js`, `run/11.5/love.min.js`, issues #3, #4, #6, #9, #15, #18)
- github.com/ytrewq000/Balatro-Web-Port
- github.com/blake502/balatro-mobile-maker (`Patching.cs`, `Constants.cs`)
- github.com/Davidobot/love.js (README, `build_lovejs.sh`, issues #106, #110, #112, #114) and Davidobot/love@emscripten (`CMakeLists.txt`, `EmscriptenPersistence.js`)
- github.com/2dengine/love.js (README, `player.js`, `lua/normalize*.lua`) and 2dengine.com/doc/lovejs.html
- github.com/alexjgriffith/update-lovejs (makefile, `scripts/build.sh`, releases 115-beta2.3)
- npm registry `love.js` (latest 11.4.1, 2022-08-25)
- balatro-src/balatro-src-reverse-engineering (`main.lua`, `game.lua`, `globals.lua`, `conf.lua`, `version.jkr` 1.0.1o)
- PortsMaster/PortMaster-New `ports/balatro` conf.lua
- NixOS/nixpkgs `pkgs/by-name/ba/balatro`
- htruccoUCSC/Love2DTest and mpwsh/strafox workflows
- Apple Newsroom 2024-09-05 (Balatro+ on Arcade, 2024-09-26); AppleInsider 2024-09-26; TouchArcade 2024-09-05
