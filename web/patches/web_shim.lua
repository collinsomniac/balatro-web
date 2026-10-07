-- web_shim.lua: makes Balatro (LÖVE 11.x / LuaJIT) run on love.js (PUC Lua 5.1 in wasm).
-- Injected by the browser loader into the player's own copy of the game. This file is our code only.
local WEB = { version = 'web-shim 0.3', frames = 0, long = 0, worst = 0, t = 0,
  opts = { fps_cap = 60, skip_splash = true } }
_G.__WEB = WEB

local function emit(kind, payload)  -- Lua -> JS (the page routes "__WEB__:" lines)
  print('__WEB__:' .. kind .. (payload and (' ' .. payload) or ''))
end
WEB.emit = emit

-- 0. Command handlers coming from the page.
WEB.handlers = {}

-- 1. LuaJIT `bit` library: pure-Lua polyfill.
package.preload['bit'] = function()
  local M = {}
  local function norm(x) x = x % 4294967296; if x >= 2147483648 then x = x - 4294967296 end; return x end
  local function tou(x) return x % 4294967296 end
  local function bitop(a, b, f)
    a, b = tou(a), tou(b); local r, p = 0, 1
    for _ = 1, 32 do
      local x, y = a % 2, b % 2
      if f(x, y) then r = r + p end
      a, b, p = (a - x) / 2, (b - y) / 2, p * 2
    end
    return norm(r)
  end
  function M.band(a, b) return bitop(a, b, function(x, y) return x == 1 and y == 1 end) end
  function M.bor(a, b) return bitop(a, b, function(x, y) return x == 1 or y == 1 end) end
  function M.bxor(a, b) return bitop(a, b, function(x, y) return x ~= y end) end
  function M.bnot(a) return norm(-1 - tou(a)) end
  function M.lshift(a, n) return norm(tou(a) * 2 ^ (n % 32)) end
  function M.rshift(a, n) return norm(math.floor(tou(a) / 2 ^ (n % 32))) end
  function M.arshift(a, n) return norm(math.floor(norm(a) / 2 ^ (n % 32))) end
  function M.tobit(a) return norm(a) end
  return M
end

-- 1b. Lua 5.4 renames (harmless on 5.1).
_G.loadstring = _G.loadstring or _G.load
if not _G.unpack and table.unpack then _G.unpack = table.unpack end

-- 2. `jit` stub.
_G.jit = _G.jit or { arch = 'wasm32', os = 'Web', version = 'none', off = function() end, on = function() end, flush = function() end }

-- 3. Lua 5.1 vs LuaJIT math.
local _log = math.log
math.log = function(x, base) if base then return _log(x) / _log(base) end return _log(x) end
local _seed = math.randomseed  -- PUC truncates float seeds -> every (0,1) seed became 0
math.randomseed = function(x)
  x = tonumber(x) or 0
  if x ~= math.floor(x) or math.abs(x) < 1 then x = math.floor((x % 1) * 2147483646) + 1 end
  return _seed(x % 2147483647)
end

-- 4. love.thread -> coroutines on the main thread (save manager etc).
local channels = {}
local Channel = {}; Channel.__index = Channel
local function get_channel(name)
  if not channels[name] then channels[name] = setmetatable({ name = name, q = {}, consumers = {} }, Channel) end
  return channels[name]
end
function Channel:push(v)
  table.insert(self.q, v)
  for _, co in ipairs(self.consumers) do
    if coroutine.status(co) == 'suspended' and co ~= coroutine.running() then
      local ok, err = coroutine.resume(co)
      if not ok then emit('error', 'thread: ' .. tostring(err)) end
    end
  end
  return true
end
Channel.supply = Channel.push
function Channel:pop() return table.remove(self.q, 1) end
function Channel:peek() return self.q[1] end
function Channel:getCount() return #self.q end
function Channel:clear() self.q = {} end
function Channel:demand()
  while #self.q == 0 do
    local co = coroutine.running()
    if not co then return nil end
    local known = false
    for _, c in ipairs(self.consumers) do if c == co then known = true end end
    if not known then table.insert(self.consumers, co) end
    coroutine.yield()
  end
  return table.remove(self.q, 1)
end
local Thread = {}; Thread.__index = Thread
function Thread:start(...)
  local args = { ... }
  local chunk, err = love.filesystem.load(self.path)
  if not chunk then emit('error', 'cannot load thread ' .. self.path .. ': ' .. tostring(err)); return end
  self.co = coroutine.create(function() return chunk(unpack(args)) end)
  local ok, e = coroutine.resume(self.co)
  if not ok then self.err = e; emit('error', 'thread ' .. self.path .. ' died: ' .. tostring(e)) end
end
function Thread:isRunning() return self.co ~= nil and coroutine.status(self.co) ~= 'dead' end
function Thread:getError() return self.err end
function Thread:wait() end
love.thread = love.thread or {}
love.thread.getChannel = get_channel
love.thread.newChannel = function() return setmetatable({ q = {}, consumers = {} }, Channel) end
love.thread.newThread = function(path) return setmetatable({ path = path }, Thread) end
package.loaded['love.thread'] = love.thread

-- 5. Saves: the runtime autopersists IDBFS; also ask the page to flush soon after writes.
local _write = love.filesystem.write
love.filesystem.write = function(...)
  local a, b = _write(...)
  WEB.dirty = true
  return a, b
end

-- 6. Images: WebGL can't mipmap non-power-of-two textures; Balatro atlases aren't POT.
local _newImage = love.graphics.newImage
love.graphics.newImage = function(src, settings)
  if type(settings) == 'table' and settings.mipmaps then
    settings = { dpiscale = settings.dpiscale, linear = settings.linear }
  end
  return _newImage(src, settings)
end

-- 7. Errors / perf telemetry (cheap: one line every 2 s).
function WEB.on_error(msg)
  emit('error', tostring(msg) .. '\n' .. debug.traceback('', 3))
end
function WEB.long_dt(dt)
  WEB.long = WEB.long + 1
  if dt > WEB.worst then WEB.worst = dt end
end
function WEB.tick(dt)
  WEB.frames = WEB.frames + 1
  WEB.t = WEB.t + (dt or 0)
  if WEB.t >= 2 then
    local G = _G.G
    emit('perf', string.format('{"fps":%d,"long":%d,"worst_ms":%d,"state":%s,"w":%d,"h":%d,"mem_kb":%d}',
      love.timer.getFPS(), WEB.long, math.floor(WEB.worst * 1000), tostring(G and G.STATE or -1),
      love.graphics.getPixelWidth(), love.graphics.getPixelHeight(), math.floor(collectgarbage('count'))))
    if WEB.dirty then WEB.dirty = false; emit('sync') end
    WEB.t, WEB.long, WEB.worst = 0, 0, 0
  end
  if WEB.pending then  -- JS -> Lua commands (set by love.handlers.web below)
    local p = WEB.pending; WEB.pending = nil
    for _, c in ipairs(p) do WEB.handle(c) end
  end
end

-- 7b. Display: emscripten reports the physical screen (always portrait on iPhone), so the engine would
-- open a portrait window. We report the real CSS viewport instead and re-apply it on rotation.
WEB.viewport = WEB.viewport or { w = 1280, h = 720 }
local function vp() return math.floor(WEB.viewport.w + 0.5), math.floor(WEB.viewport.h + 0.5) end
love.window.getDesktopDimensions = function() local w, h = vp(); return w, h end
love.window.getFullscreenModes = function() local w, h = vp(); return { { width = w, height = h } } end
love.window.getDisplayCount = function() return 1 end
love.window.getDisplayName = function() return 'Browser' end
local _updateMode = love.window.updateMode
love.window.updateMode = function(w, h, flags)
  flags = flags or {}
  flags.fullscreen = false            -- no Fullscreen API on iPhone; full screen comes from the web app
  flags.fullscreentype = nil
  flags.resizable = true
  flags.highdpi = true
  local vw, vh = vp()
  if not w or not h or w <= 0 or h <= 0 or w ~= vw or h ~= vh then w, h = vw, vh end
  local ok, a, b = pcall(_updateMode, w, h, flags)
  return ok and a or b
end
love.window.setMode = function(w, h, flags) return love.window.updateMode(w, h, flags) end
WEB.handlers.viewport = function(d)
  if not d or not d.w or not d.h then return end
  local w, h = math.floor(d.w), math.floor(d.h)
  local changed = (w ~= math.floor(WEB.viewport.w)) or (h ~= math.floor(WEB.viewport.h))
  WEB.viewport = { w = w, h = h }
  -- Only resize when the engine's window truly disagrees. Calling updateMode on every message makes the
  -- game rebuild its canvases in a loop, which costs ~50 ms per frame.
  if love.graphics and love.graphics.isCreated() then
    local pw, ph = love.graphics.getPixelWidth(), love.graphics.getPixelHeight()
    local scale = (love.window.getDPIScale and love.window.getDPIScale()) or 1
    if math.abs(pw - w * scale) > 2 or math.abs(ph - h * scale) > 2 then
      love.window.updateMode(w, h, { fullscreen = false, resizable = true, highdpi = true, vsync = 1 })
      if love.resize then love.resize(love.graphics.getWidth(), love.graphics.getHeight()) end
      emit('viewport', string.format('{"w":%d,"h":%d,"applied":true,"pixels":%d}', w, h, pw))
      return
    end
  end
  if changed then emit('viewport', string.format('{"w":%d,"h":%d,"applied":false}', w, h)) end
end

-- 8. JS -> Lua: Module.love_send_event('web', json) -> love.userevent -> love.handlers.web(json).
-- Minimal JSON decoder (objects, arrays, strings, numbers, bools, null).
local function json_decode(s)
  local i = 1
  local function ws() i = s:find('[^ \t\r\n]', i) or (#s + 1) end
  local val
  local function str()
    local out, j = {}, i + 1
    while true do
      local c = s:sub(j, j)
      if c == '"' then i = j + 1; return table.concat(out)
      elseif c == '\\' then
        local n = s:sub(j + 1, j + 1)
        local map = { b = '\b', f = '\f', n = '\n', r = '\r', t = '\t' }
        if n == 'u' then
          local code = tonumber(s:sub(j + 2, j + 5), 16) or 63
          if code < 128 then out[#out + 1] = string.char(code)
          elseif code < 2048 then out[#out + 1] = string.char(192 + math.floor(code / 64), 128 + code % 64)
          else out[#out + 1] = string.char(224 + math.floor(code / 4096), 128 + math.floor(code / 64) % 64, 128 + code % 64) end
          j = j + 6
        else out[#out + 1] = map[n] or n; j = j + 2 end
      elseif c == '' then error('unterminated string')
      else out[#out + 1] = c; j = j + 1 end
    end
  end
  function val()
    ws(); local c = s:sub(i, i)
    if c == '{' then
      local t = {}; i = i + 1; ws()
      if s:sub(i, i) == '}' then i = i + 1; return t end
      while true do ws(); local k = str(); ws(); i = i + 1; t[k] = val(); ws()
        local d = s:sub(i, i); i = i + 1; if d == '}' then return t end end
    elseif c == '[' then
      local t = {}; i = i + 1; ws()
      if s:sub(i, i) == ']' then i = i + 1; return t end
      while true do t[#t + 1] = val(); ws(); local d = s:sub(i, i); i = i + 1; if d == ']' then return t end end
    elseif c == '"' then return str()
    elseif s:sub(i, i + 3) == 'true' then i = i + 4; return true
    elseif s:sub(i, i + 4) == 'false' then i = i + 5; return false
    elseif s:sub(i, i + 3) == 'null' then i = i + 4; return nil
    else local n = s:match('^-?%d+%.?%d*[eE]?[-+]?%d*', i); i = i + #n; return tonumber(n) end
  end
  return val()
end
WEB.json_decode = json_decode
love.handlers.web = function(data)
  local ok, msg = pcall(json_decode, data or '')
  if not ok or type(msg) ~= 'table' then emit('error', 'bad web event: ' .. tostring(msg)); return end
  WEB.pending = WEB.pending or {}
  table.insert(WEB.pending, { name = msg.c, data = msg.d })
end
function WEB.handle(c)
  local h = WEB.handlers[c.name]
  if h then local ok, e = pcall(h, c.data); if not ok then emit('error', 'handler ' .. c.name .. ': ' .. tostring(e)) end end
end
WEB.handlers.eval = function(src)  -- dev only: the page decides whether to allow it
  local f, e = loadstring(src); if not f then emit('eval', 'compile error: ' .. e) return end
  local ok, r = pcall(f); emit('eval', tostring(ok) .. ' ' .. tostring(r))
end
-- Shell options (frame cap, skip the intro). The page sends these after the engine reports boot.
WEB.handlers.opts = function(d)
  if type(d) ~= 'table' then return end
  for k, v in pairs(d) do WEB.opts[k] = v end
  emit('opts', string.format('{"fps_cap":%s,"skip_splash":%s}', tostring(WEB.opts.fps_cap), tostring(WEB.opts.skip_splash)))
end

-- Diagnostics the shell can ask for.
WEB.handlers.probe = function()
  local G = _G.G
  local ok, info = pcall(function()
    local S = G and G.SETTINGS
    local SO = (S and S.SOUND) or {}
    local n = (love.audio and love.audio.getActiveSourceCount) and love.audio.getActiveSourceCount() or -1
    local srcs = love.filesystem.getDirectoryItems and #love.filesystem.getDirectoryItems('resources/sounds') or -1
    return string.format('{"audio_ok":%s,"active_sources":%d,"volume":%s,"sfx":%s,"music":%s,"mute":%s,' ..
      '"sound_files":%d,"skip_splash":%s,"fps_cap":%s,"shim":"%s"}',
      tostring(love.audio ~= nil), n, tostring(SO.volume), tostring(SO.game_sounds_volume),
      tostring(SO.music_volume), tostring(G and G.F_MUTE), srcs, tostring(S and S.skip_splash),
      tostring(WEB.opts.fps_cap), WEB.version)
  end)
  emit('probe', ok and info or ('{"error":"' .. tostring(info):gsub('"', "'") .. '"}'))
end

WEB.handlers.state = function() emit('state', WEB.state()) end
-- Screenshot from inside LÖVE (WebGL drawing buffers are cleared after compositing, so JS can't read them).
WEB.handlers.shot = function()
  love.graphics.captureScreenshot(function(img)
    local fd = img:encode('png')
    local b64 = love.data.encode('string', 'base64', fd:getString())
    emit('shot', b64)
  end)
end
function WEB.state()
  local G = _G.G
  if not G or not G.GAME then return '{}' end
  local GM = G.GAME
  return string.format('{"state":%s,"ante":%s,"round":%s,"dollars":%s,"chips":%s,"hands":%s,"discards":%s}',
    tostring(G.STATE), tostring(GM.round_resets and GM.round_resets.ante or 0), tostring(GM.round or 0),
    tostring(GM.dollars or 0), tostring(GM.chips or 0),
    tostring(GM.current_round and GM.current_round.hands_left or 0), tostring(GM.current_round and GM.current_round.discards_left or 0))
end

emit('boot', string.format('{"shim":"%s","os":"%s","love":"%s"}', WEB.version, love.system.getOS(),
  table.concat({ love.getVersion() }, '.', 1, 3)))
