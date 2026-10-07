#!/usr/bin/env python3
"""Patch a user's Balatro game.love (or Balatro.exe) for love.js. Dev-time mirror of the in-browser patcher.
usage: patch_love.py <Balatro.exe|game.love> <out.love>
Every patch is an exact-string replacement that must match once; failure is loud (game version drift)."""
import sys, zipfile, io, os
HERE = os.path.dirname(os.path.abspath(__file__))
SHIM = open(os.path.join(HERE, '..', 'src', 'patches', 'web_shim.lua')).read()

PATCHES = [
  # file, old, new, label
  ('main.lua', "if (love.system.getOS() == 'OS X' ) and (jit.arch == 'arm64' or jit.arch == 'arm') then jit.off() end",
               "require 'web_shim'", 'load shim first'),
  ('main.lua', "if os == 'OS X' or os == 'Windows' then", "if false then", 'skip Steam (luasteam)'),
  ('main.lua', "function love.errhand(msg)\n", "function love.errhand(msg)\n\tif __WEB then print('__WEB__:ERROR '..tostring(msg)..'\\n'..debug.traceback('',2)) return end\n", 'non-blocking error handler'),
  ('main.lua', "    G:update(dt)\n", "    G:update(dt)\n    __WEB.tick(dt)\n", 'save flush tick'),
  ('globals.lua', "    self.F_MOBILE_UI = false\n",
                  "    self.F_MOBILE_UI = false\n    self.F_SOUND_THREAD = false --web: WebAudio is main-thread\n    self.F_SAVE_TIMER = 5\n    self.F_CRASH_REPORTS = false\n    self.F_QUIT_BUTTON = false\n", 'web flags'),
  ('resources/shaders/hologram.fs', "int glow_samples = 4;", "const int glow_samples = 4;", 'GLSL ES const loop bound'),
]

def load_zip(path):
    d = open(path, 'rb').read()
    i = d.find(b'PK\x03\x04')
    return zipfile.ZipFile(io.BytesIO(d[i:]))

def main(src, out):
    z = load_zip(src)
    files = {n: z.read(n) for n in z.namelist() if not n.endswith('/')}
    ver = files.get('version.jkr', b'?').decode(errors='replace').split('\n')[0]
    for f, old, new, label in PATCHES:
        s = files[f].decode('utf-8')
        n = s.count(old)
        if n != 1: raise SystemExit(f'PATCH FAILED [{label}] {f}: expected 1 match, found {n} (game version {ver})')
        files[f] = s.replace(old, new).encode('utf-8')
        print(f'  ok  {label}')
    files['web_shim.lua'] = SHIM.encode()
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=1) as o:
        for n, b in files.items(): o.writestr(n, b)
    print(f'patched {ver}: {len(files)} files -> {out} ({os.path.getsize(out)//1024} KB)')

if __name__ == '__main__': main(sys.argv[1], sys.argv[2])
