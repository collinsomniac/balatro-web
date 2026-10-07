#!/usr/bin/env python3
"""Turn a love.js index.html into t.html with: log beacon, Lua→JS print bridge, IDBFS flush, canvas fit."""
import sys
d = sys.argv[1]
s = open(d + '/index.html').read()
s = s.replace('<head>', '<head><script src="/beacon.js"></script>', 1)
s = s.replace('printErr: console.error.bind(console),', '''print:(...a)=>{const t=a.join(' ');
          if(t.startsWith('__WEB__:sync')){window.__flush&&__flush('lua')}
          else if(t.startsWith('__WEB__:ERROR')){console.error('LUA '+t.slice(8))}
          else console.log(t)},
        printErr:(...a)=>console.error(...a),''')
s = s.replace('</body>', '''<script>
window.__flush=function(why){try{const F=Module.FS; if(!F) return; F.syncfs(false,e=>window.__send&&__send('syncfs '+why+' '+(e||'ok')))}catch(e){window.__send&&__send('flush err '+e)}};
addEventListener('pagehide',()=>__flush('pagehide'));
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')__flush('hidden')});
</script></body>''')
open(d + '/t.html', 'w').write(s)
