-- cardreveal.lua — the dramatic reveal for a generated card.
-- Modelled on the game's own pack-opening flourish (swirling background, card flying in), recoloured, with a
-- silhouette "who's that joker" wait that holds indefinitely until the design arrives, then a shake and reveal.
-- Part of the web port. Nothing here comes from the game.
local CR = { version = 'cardreveal 0.1', active = false, phase = 'idle', t = 0 }
_G.__CARDREVEAL = CR

local ZOOM_PERIOD = 7.0        -- one slow zoom cycle (seconds)
local SHAKE_TIME = 1.3
local REVEAL_TIME = 0.7
local BG_COLOUR = { 0.42, 0.16, 0.62 }   -- purple variation of the pack-open colour

local function atlas_sprite()
  local a = G and G.ASSET_ATLAS and G.ASSET_ATLAS['ui_1']
  if not a then return nil end
  local ok, sprite = pcall(Sprite, -30, -13, G.ROOM.T.w + 60, G.ROOM.T.h + 22, a, { x = 2, y = 0 })
  return ok and sprite or nil
end

function CR.start(topic)
  CR.active = true
  CR.phase = 'wait'
  CR.t = 0
  CR.topic = topic or 'something'
  CR.spec, CR.card, CR.key = nil, nil, nil
  CR.bg = CR.bg or atlas_sprite()
  if play_sound then pcall(play_sound, 'whoosh_long', 0.9, 0.6) end
  if __WEB then __WEB.emit('reveal', 'waiting: ' .. tostring(CR.topic)) end
end

function CR.deliver(spec)
  CR.spec = spec
  if not CR.active then CR.start(spec and spec.name or 'a card') end
  -- register it as a real card so the reveal shows what the player will actually get
  local ok, key = pcall(function() return _G.__CARDGEN and __CARDGEN.register(spec) end)
  CR.key = ok and key or nil
  if CR.key then
    local okc, card = pcall(Card, 0, 0, G.CARD_W, G.CARD_H, nil, G.P_CENTERS[CR.key], { bypass_discovery_center = true })
    CR.card = okc and card or nil
  end
  CR.phase = 'ready'          -- wait for a safe point in the animation before the shake
  if __WEB then __WEB.emit('reveal', 'delivered: ' .. tostring(spec and spec.name)) end
end

function CR.hide()
  CR.active = false
  CR.phase = 'idle'
  CR.spec = nil
  if __WEB then __WEB.emit('reveal', 'hidden') end
end

-- where the silhouette sits; eased in from the centre
local function card_rect()
  local w, h = G.CARD_W * 2.6, G.CARD_H * 2.6
  return (love.graphics.getWidth() - w) / 2, (love.graphics.getHeight() - h) / 2, w, h
end

local function draw_background(zoom)
  local a = G and G.ASSET_ATLAS and G.ASSET_ATLAS['ui_1']
  if not a then return end
  love.graphics.setColor(BG_COLOUR[1], BG_COLOUR[2], BG_COLOUR[3], 1)
  local sw, sh = a.image:getWidth() / 10, a.image:getHeight() / 10
  local qw, qh = a.image:getWidth() / 10, a.image:getHeight() / 10
  love.graphics.draw(a.image, love.graphics.newQuad(2 * sw, 0, sw, sh, a.image:getWidth(), a.image:getHeight()),
    0, 0, 0, love.graphics.getWidth() * zoom / qw, love.graphics.getHeight() * zoom / qh)
  love.graphics.setColor(0, 0, 0, 0.55)
  love.graphics.rectangle('fill', 0, 0, love.graphics.getWidth(), love.graphics.getHeight())
end

local function draw_silhouette(x, y, w, h, shake, pulse)
  love.graphics.push()
  love.graphics.translate(x + w / 2 + shake, y + h / 2 + math.abs(shake) * 0.4)
  love.graphics.rotate(math.sin(CR.t * 22) * (shake / 90))
  love.graphics.scale(1 + pulse * 0.02, 1 + pulse * 0.02)
  love.graphics.translate(-w / 2, -h / 2)
  love.graphics.setColor(0, 0, 0, 1)
  love.graphics.rectangle('fill', 0, 0, w, h, 0.3)
  love.graphics.setColor(1, 1, 1, 0.08 + 0.05 * pulse)
  love.graphics.setLineWidth(2)
  love.graphics.rectangle('line', 0, 0, w, h, 0.3)
  -- the card's own art, drawn black: a true silhouette
  if CR.spec and CR.spec.art and CR.spec.art.pos and G.ASSET_ATLAS['Jokers'] then
    local a = G.ASSET_ATLAS['Jokers']
    local sw, sh = a.image:getWidth() / 10, a.image:getHeight() / 5
    love.graphics.setColor(0, 0, 0, 1)
    love.graphics.draw(a.image, love.graphics.newQuad((CR.spec.art.pos.x or 0) * sw, (CR.spec.art.pos.y or 0) * sh, sw, sh,
      a.image:getWidth(), a.image:getHeight()), w * 0.12, h * 0.12, 0, (w * 0.76) / sw, (h * 0.76) / sh)
  end
  love.graphics.pop()
end

local function draw_card(x, y, w, h, scale, flash)
  if not CR.card then return end
  love.graphics.push()
  love.graphics.translate(x + w / 2, y + h / 2)
  love.graphics.scale(scale, scale)
  love.graphics.translate(-G.CARD_W / 2, -G.CARD_H / 2)
  local ok = pcall(function() CR.card:draw() end)
  love.graphics.pop()
  if flash > 0 then
    love.graphics.setColor(1, 1, 1, flash)
    love.graphics.rectangle('fill', 0, 0, love.graphics.getWidth(), love.graphics.getHeight())
  end
end

function CR.update(dt)
  if not CR.active or not G or not G.STATE then return end
  CR.t = CR.t + dt
  if CR.phase == 'wait' then
    -- stay in a seamless loop; nothing depends on the wait length
  elseif CR.phase == 'ready' then
    -- wait for the end of the current zoom cycle so the shake lands on a beat
    local cycle = (CR.t % ZOOM_PERIOD) / ZOOM_PERIOD
    if cycle > 0.92 or CR.t > 40 then
      CR.phase = 'shake'
      CR.t0 = CR.t
      if play_sound then pcall(play_sound, 'card1', 1, 0.8) end
    end
  elseif CR.phase == 'shake' then
    if CR.t - CR.t0 > SHAKE_TIME then
      CR.phase = 'reveal'
      CR.t0 = CR.t
      if play_sound then pcall(play_sound, 'whoosh_long', 0.7, 1) end
    end
  elseif CR.phase == 'reveal' then
    if CR.t - CR.t0 > REVEAL_TIME then CR.phase = 'hold'; CR.t0 = CR.t end
  elseif CR.phase == 'hold' then
    if CR.t - CR.t0 > 9 then CR.hide() end
  end
end

function CR.draw()
  if not CR.active then return end
  love.graphics.push()
  love.graphics.origin()
  love.graphics.setShader()

  local cycle = (CR.t % ZOOM_PERIOD) / ZOOM_PERIOD
  local zoom = 1.15 + 0.25 * cycle
  if CR.phase == 'shake' or CR.phase == 'reveal' then zoom = zoom + (CR.t - CR.t0) * 0.35 end
  draw_background(zoom)

  local x, y, w, h = card_rect()
  local pulse = math.sin(CR.t * 3.4)
  if CR.phase == 'wait' or CR.phase == 'ready' then
    draw_silhouette(x, y, w, h, 0, pulse)
    love.graphics.setColor(1, 1, 1, 0.9)
    love.graphics.printf("Who's that Joker?", 0, love.graphics.getHeight() * 0.82, love.graphics.getWidth(), 'center')
    love.graphics.setColor(1, 1, 1, 0.55)
    love.graphics.printf('designing a card for "' .. tostring(CR.topic) .. '"…', 0,
      love.graphics.getHeight() * 0.82 + 28, love.graphics.getWidth(), 'center')
  elseif CR.phase == 'shake' then
    local k = (CR.t - CR.t0) / SHAKE_TIME
    draw_silhouette(x, y, w, h, math.sin(CR.t * 60) * 14 * (1 - k * 0.4), pulse + 2)
  elseif CR.phase == 'reveal' or CR.phase == 'hold' then
    local k = math.min(1, (CR.t - CR.t0) / REVEAL_TIME)
    local scale = 1 + 0.35 * (1 - k) * math.sin(k * math.pi)
    local flash = CR.phase == 'reveal' and (1 - k) * 0.75 or 0
    love.graphics.setColor(1, 1, 1, scale > 1.02 and 0.18 or 0)
    draw_card(x, y, w, h, scale, flash)
    if CR.spec then
      local cy = y + h + 18
      love.graphics.setColor(1, 1, 1, math.min(1, k * 2))
      love.graphics.printf(tostring(CR.spec.name), 0, cy, love.graphics.getWidth(), 'center')
      love.graphics.setColor(1, 0.91, 0.66, k)
      love.graphics.printf(table.concat(CR.spec.text or {}, '\n'), 0, cy + 30, love.graphics.getWidth(), 'center')
      love.graphics.setColor(1, 1, 1, 0.5 * k)
      love.graphics.printf('★ ' .. tostring(CR.spec.rarity or 1) .. '   ·   $' .. tostring(CR.spec.cost or 4) ..
        '   ·   tap to continue', 0, cy + 30 + 20 * #(CR.spec.text or { ' ' }), love.graphics.getWidth(), 'center')
    end
  end
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.pop()
end

-- input: tap anywhere to dismiss once revealed
function CR.mousepressed()
  if CR.active and (CR.phase == 'reveal' or CR.phase == 'hold') then CR.hide() return true end
  return false
end

-- Bridge commands from the page
if __WEB and __WEB.handlers then
  __WEB.handlers.cardpending = function(d)
    CR.start(type(d) == 'table' and d.topic or d)
  end
  __WEB.handlers.cardreveal = function(spec) CR.deliver(spec) end
  __WEB.handlers.cardhide = function() CR.hide() end
end

-- Install the draw/update hooks once the game is up.
function CR.install()
  if CR.installed then return end
  CR.installed = true
  local _update, _draw = love.update, love.draw
  love.update = function(dt) if _update then _update(dt) end pcall(CR.update, dt) end
  love.draw = function() if _draw then _draw() end pcall(CR.draw) end
  local _mp = love.mousepressed
  love.mousepressed = function(x, y, b, t)
    if not CR.mousepressed() and _mp then _mp(x, y, b, t) end
  end
  if __WEB then __WEB.emit('reveal', 'installed') end
end

-- installed from the shim on the first frame, once the game has defined love.update/love.draw
