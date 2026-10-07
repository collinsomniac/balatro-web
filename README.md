# Balatro Web

Play **your own copy** of Balatro in a browser — built for iPhone, with co-op planned.

This repository ships **engine code only**. It contains no game assets, no game source, and no copyrighted
material: you supply your own `Balatro.exe` (or `game.love`), and the page patches and runs it in your
browser. Your game file is stored only in your browser's IndexedDB, never uploaded.

## How it works

```
your Balatro.exe ──► browser: find the zip inside the exe ──► apply patches/balatro-1.0.1.json (in-browser)
                     └─► LÖVE 11.5 (love.js / Emscripten, single-threaded) runs it full-screen
```

* `web/runtime/` — LÖVE 11.5 compiled to WebAssembly ([alexjgriffith/update-lovejs](https://github.com/alexjgriffith/update-lovejs), GPL-3.0). One upstream fix: `doRun` waits for run dependencies, so the save store can finish loading before the game starts (`runtime/PATCHES.txt`).
* `web/patches/balatro-1.0.1.json` — exact-match source patches (bit-library polyfill, main-thread threads, no Steam, WebGL-safe shaders, web platform flags). Each patch must match exactly once, so an unsupported game version fails loudly instead of half-working.
* `web/patches/web_shim.lua` — injected Lua shim: LuaJIT and thread compatibility, save flushing, display handling, and a small command bridge used by the shell.
* `web/app.js` — file picker, in-browser patching, IndexedDB storage, full-screen/landscape handling, save export, and the page↔engine bridge.
* `tools/` — the on-device development loop (build a patched `.love`, serve it with COOP/COEP headers, drive the page).
* `research/`, `design/` — notes behind the port (multiplayer scene, web runtime options, asset backends).

## Run it

1. Open the site (GitHub Pages).
2. Tap **Choose Balatro.exe or game.love** and pick your copy (Steam: `steamapps/common/Balatro/Balatro.exe`). It is patched on your device and cached in this browser.
3. **Tap to play.**
4. iPhone: **Share → Add to Home Screen**, launch from the icon, and turn the phone sideways for true full-screen (iOS has no Fullscreen API in Safari tabs).

Saves live in the browser (`Export saves` copies them out as a zip).

## Development on device

```sh
sh tools/build_dev.sh                 # patch input/game.love for local testing (keeps output in local/, gitignored)
python3 /var/minis/shared/webgames/tools/dev_server.py web 8765 --game input/game.love --env OPENROUTER_API_KEY
```
Then open `http://127.0.0.1:8765/?devgame&tag=t1` and drive it through the server: `POST /__cmd` with
`play`, `tap`, `shot` or `lua <code>`; `GET /__log` returns the page's log.

## Status

Works: boots to the main menu and plays at 60 fps in landscape on iPhone 17 Pro Max (LÖVE 11.5, single-threaded).
Known: the intro splash dips to 10–20 fps (asset decode + shader compiles), touch input still being tuned,
audio untested, co-op and the Wikipedia card-generation mode are in progress.

## Licensing

Our code: MIT (see `LICENSE`). LÖVE 11.5 web runtime: GPL-3.0 (`web/runtime/LICENSE-update-lovejs.txt`).
fflate: MIT (`web/vendor/LICENSE-fflate.txt`). Balatro is © LocalThunk / Playstack — not included, not
distributed, and required to be supplied by the player.
