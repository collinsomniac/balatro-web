-- Window setup for the web build. Our own conf.lua replaces the game's, so these are always applied.
function love.conf(t)
  t.identity = 'balatro-web'          -- save folder (persisted in the browser's IndexedDB)
  t.console = false
  t.title = 'Balatro'
  t.window.width = 0
  t.window.height = 0
  t.window.minwidth = 100
  t.window.minheight = 100
  t.window.resizable = true
  t.window.highdpi = true
  t.window.vsync = 1
end
