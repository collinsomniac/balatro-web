-- web_shim.lua — makes Balatro (LÖVE 11.x / LuaJIT) run on love.js (PUC Lua 5.1, wasm).
-- Loaded first by main.lua. Engine code only; contains nothing from the game.
local WEB = { version = 'web-shim 0.1' }
_G.__WEB = WEB

-- 1. LuaJIT `bit` library: pure-Lua polyfill (only 32-bit ops Balatro could reach).
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

-- 2. `jit` table (only debug/profile code touches it on non-macOS).
_G.jit = _G.jit or { arch = 'wasm32', os = 'Web', version = 'none', off = function() end, on = function() end, flush = function() end }

-- 3. Lua 5.1 math differences vs LuaJIT.
local _log = math.log
math.log = function(x, base) if base then return _log(x) / _log(base) end return _log(x) end
-- PUC 5.1 randomseed() truncates to int, so Balatro's (0,1) float seeds all became 0 → identical "random" runs.
local _seed = math.randomseed
math.randomseed = function(x)
  x = tonumber(x) or 0
  if x ~= math.floor(x) or math.abs(x) < 1 then x = math.floor((x % 1) * 2147483646) + 1 end
  return _seed(x % 2147483647)
end

-- 4. Threads → coroutines on the main thread (love.js compat build has no pthreads; WebAudio is main-thread only).
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
      if not ok then print('[web_shim] thread error: ' .. tostring(err)) end
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
  if not chunk then print('[web_shim] cannot load thread ' .. self.path .. ': ' .. tostring(err)); return end
  self.co = coroutine.create(function() return chunk(unpack(args)) end)
  local ok, e = coroutine.resume(self.co)
  if not ok then self.err = e; print('[web_shim] thread ' .. self.path .. ' died: ' .. tostring(e)) end
end
function Thread:isRunning() return self.co ~= nil and coroutine.status(self.co) ~= 'dead' end
function Thread:getError() return self.err end
function Thread:wait() end

love.thread = love.thread or {}
love.thread.getChannel = get_channel
love.thread.newChannel = function() return setmetatable({ q = {}, consumers = {} }, Channel) end
love.thread.newThread = function(path) return setmetatable({ path = path }, Thread) end
package.loaded['love.thread'] = love.thread

-- 5. Saves: ask the page to flush IDBFS to disk after every write (iOS Safari rarely fires beforeunload).
local _write = love.filesystem.write
love.filesystem.write = function(...)
  local r1, r2 = _write(...)
  WEB.dirty = true
  return r1, r2
end
WEB.flush_timer = 0
function WEB.tick(dt)
  WEB.flush_timer = WEB.flush_timer + (dt or 0)
  if WEB.dirty and WEB.flush_timer > 0.5 then
    WEB.dirty, WEB.flush_timer = false, 0
    print('__WEB__:sync')
  end
end

-- 6. Images: WebGL1 can only mipmap power-of-two textures. Balatro's atlases aren't, so drop mipmaps.
local _newImage = love.graphics.newImage
love.graphics.newImage = function(src, settings)
  if type(settings) == 'table' and settings.mipmaps then
    settings = { dpiscale = settings.dpiscale, linear = settings.linear }
  end
  local ok, img = pcall(_newImage, src, settings)
  if ok then return img end
  print('[web_shim] newImage failed for ' .. tostring(src) .. ': ' .. tostring(img))
  error(img, 2)
end
if love.graphics.setDefaultMipmapFilter then
  local _f = love.graphics.setDefaultMipmapFilter
  love.graphics.setDefaultMipmapFilter = function(...) pcall(_f, ...) end
end

-- 6b. Never block the page in an error loop: log the error + traceback, then let love.js show its screen.
WEB.install_errhand = function()
  local orig = love.errhand
  love.errhand = function(msg)
    print('__WEB__:ERROR ' .. tostring(msg) .. '\n' .. debug.traceback('', 2))
    return nil
  end
end

-- 7. Test hook surface for the agent (read via print → page console).
function WEB.state()
  local G = _G.G
  if not G then return 'no G' end
  return string.format('STATE=%s stage=%s fps=%d', tostring(G.STATE), tostring(G.STAGE), love.timer.getFPS())
end

print('[web_shim] loaded ' .. WEB.version .. ' os=' .. love.system.getOS() .. ' love=' .. table.concat({ love.getVersion() }, '.', 1, 3))
