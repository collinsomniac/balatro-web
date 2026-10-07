#!/bin/sh
# Dev build: patch the user's game.love, package with love.js (compat + threaded), add dev page hooks.
# Output goes to local/ (never committed — it contains the user's game data).
set -e
B=/var/minis/shared/webgames/balatro
LJ=${LJ:-/tmp/lj/package}
[ -d "$LJ" ] || { mkdir -p /tmp/lj && cd /tmp/lj && npm pack love.js >/dev/null 2>&1 && tar xzf love.js-*.tgz && cd package && npm i --omit=dev >/dev/null 2>&1; }
cd $B
python3 tools/patch_love.py input/game.love input/patched.love
for m in ${MODES:-compat threaded}; do
  f=""; [ $m = compat ] && f=-c
  rm -rf local/p-$m
  (cd $LJ && node index.js $B/input/patched.love $B/local/p-$m $f -t Balatro -m ${MEM:-268435456} 2>/dev/null)
  sed -i 's/Module\["FS_createPath"\]=FS.createPath;/Module["FS_createPath"]=FS.createPath;Module["FS"]=FS;/' local/p-$m/love.js
  python3 tools/devpage.py local/p-$m
done
cp /var/minis/shared/webgames/tools/beacon.js local/beacon.js
echo "built: $(date +%T)"
