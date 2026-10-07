-- cardreveal.lua — the "generate a Joker" moment, built out of the game's own parts.
-- A real CardArea with a real Card in it, a UIBox like the pack screens, a caption that swaps as the design
-- arrives, and a G.E_MANAGER sequence: idle wobble -> shake -> flip (the game's own flip) -> take.
-- Part of the web port; nothing here comes from the game.
local CR = { version = 'cardreveal 0.2', moment = false, phase = 'idle', t = 0 }
_G.__CARDREVEAL = CR

local SHAKE = 1.2
local WOB = { amp = 0.012, speed = 5.5 }

local function txt(lines, colour, scale)
  return { n = G.UIT.O, config = { object = DynaText({ string = lines, colours = { colour or G.C.CLEAR },
    shadow = true, float = true, bump = true, scale = scale or 0.5, spacing = 1.2, pop_in = 0.4, maxw = 9 }) } }
end

local function kill_box(b) if b then pcall(function() b:remove() end) end end

-- ---------- the caption under the card ----------
function CR.caption(lines, colour)
  kill_box(CR.textbox)
  CR.textbox = UIBox{
    definition = { n = G.UIT.ROOT, config = { align = 'cm', colour = G.C.CLEAR, padding = 0.05 }, nodes = {
      { n = G.UIT.R, config = { align = 'cm' }, nodes = { txt(lines, colour, 0.5) } },
      CR.buttons and { n = G.UIT.R, config = { align = 'cm', padding = 0.05 }, nodes = CR.buttons } or nil,
    } },
    config = { align = 'bm', offset = { x = 0, y = 0.4 }, major = CR.box, bond = 'Weak' } }
end

function CR.buttons_for(stage)
  if stage == 'take' then
    return { { n = G.UIT.C, config = { align = 'cm', minw = 2.4, minh = 1.0, r = 0.15, colour = G.C.GREEN,
      button = 'cg_take', hover = true, shadow = true }, nodes = {
      { n = G.UIT.T, config = { text = 'Take it', scale = 0.45, colour = G.C.WHITE, shadow = true } } } },
      { n = G.UIT.C, config = { align = 'cm', minw = 2.0, minh = 1.0, r = 0.15, colour = G.C.GREY,
        button = 'cg_close', hover = true, shadow = true }, nodes = {
        { n = G.UIT.T, config = { text = 'Leave it', scale = 0.45, colour = G.C.WHITE, shadow = true } } } } }
  end
  return nil
end

-- ---------- open the moment (like a pack appearing over the shop) ----------
function CR.open(topic)
  if CR.moment then return end
  CR.prev_state = G.STATE
  CR.topic = topic or CR.current_topic or 'something from this run'
  CR.spec, CR.key, CR.card = nil, nil, nil
  CR.phase = 'waiting'
  CR.t = 0
  CR.moment = true

  pcall(function()
    CR.area = CardArea(G.ROOM.T.x + G.ROOM.T.w / 2 - G.CARD_W, G.ROOM.T.y + 1.2,
      2 * G.CARD_W, 1.45 * G.CARD_H, { card_w = G.CARD_W, card_h = G.CARD_H, type = 'pack', highlight_limit = 1 })
    CR.box = UIBox{
      definition = { n = G.UIT.ROOT, config = { align = 'cm', colour = G.C.CLEAR, padding = 0.15 }, nodes = {
        { n = G.UIT.C, config = { align = 'cm', r = 0.2, colour = G.C.DYN_UI.BOSS_MAIN, emboss = 0.05, padding = 0.15 }, nodes = {
          { n = G.UIT.O, config = { object = CR.area } },
        } },
      } },
      config = { align = 'cm', offset = { x = 0, y = -1.2 }, major = G.ROOM_ATTACH, bond = 'Weak' } }

    CR.card = Card(CR.area.T.x + CR.area.T.w / 2, CR.area.T.y, G.CARD_W, G.CARD_H, G.P_CARDS.empty,
      G.P_CENTERS.j_joker, { bypass_discovery_center = true, bypass_discovery_ui = true })
    CR.card.facing = 'back'
    CR.card.sprite_facing = 'back'
    CR.area:emplace(CR.card)
    CR.card.T.x = CR.area.T.x + CR.area.T.w / 2
    CR.card.T.y = CR.area.T.y + 0.2
  end)

  CR.buttons = nil
  CR.caption({ "Who's that Joker?", '{C:inactive}' .. tostring(CR.topic) }, G.C.WHITE)
  if play_sound then pcall(play_sound, 'whoosh_long', 0.8, 0.5) end

  G.E_MANAGER:add_event(Event({ trigger = 'immediate', func = function()
    G.E_MANAGER:add_event(Event({ trigger = 'ease', ref_table = CR, ref_value = 'zoom', ease_to = 1.06, time = 3.0 }))
    return true
  end }))
  if __WEB then __WEB.emit('reveal', 'moment open for ' .. tostring(CR.topic)) end
end

-- ---------- the design arrived ----------
function CR.deliver(spec)
  CR.spec = spec
  if not CR.moment then CR.open(spec and spec.name) end
  local key = _G.__CARDGEN and __CARDGEN.register(spec)
  CR.key = key
  pcall(function()
    if key and CR.card then
      CR.card:set_ability(G.P_CENTERS[key], true, true)
      CR.card.ability.cg_spec = spec
      CR.card.config.center = G.P_CENTERS[key]
      CR.card:set_cost()
    end
  end)
  CR.phase = 'shake'
  CR.t0 = CR.t
  if play_sound then pcall(play_sound, 'card1', 1, 0.9) end
  G.E_MANAGER:add_event(Event({ trigger = 'after', delay = SHAKE, func = function()
    CR.phase = 'flip'
    if CR.card then
      CR.card.facing = 'back'; CR.card.sprite_facing = 'back'
      CR.card:flip()                                  -- the game's own flip animation
    end
    if play_sound then pcall(play_sound, 'whoosh_long', 0.7, 1.1) end
    CR.flash = 0.85
    CR.buttons = CR.buttons_for('take')
    CR.caption({ spec.name or 'New Joker', '{C:gold}$' .. tostring(spec.cost or 4) .. '  {C:inactive}' .. string.rep('★', spec.rarity or 1) }, G.C.WHITE)
    CR.phase = 'shown'
    return true
  end }))
  if __WEB then __WEB.emit('reveal', 'delivered ' .. tostring(spec and spec.name)) end
end

function CR.close()
  if not CR.moment then return end
  CR.moment = false
  CR.phase = 'idle'
  kill_box(CR.textbox); kill_box(CR.box)
  pcall(function() if CR.area then CR.area:remove() end end)
  CR.textbox, CR.box, CR.area, CR.card = nil, nil, nil, nil
  pcall(function() if CR.prev_state then G.STATE = CR.prev_state end end)
  if __WEB then __WEB.emit('reveal', 'closed') end
end

-- ---------- per-frame: wobble, shake, flash ----------
function CR.update(dt)
  CR.t = CR.t + dt
  if not CR.moment then return end
  local card = CR.card
  if not card then return end
  if CR.phase == 'waiting' then
    card.T.r = WOB.amp * math.sin(CR.t * WOB.speed)
    card.T.y = card.area.T.y + 0.2 + 0.05 * math.sin(CR.t * 2.2)
  elseif CR.phase == 'shake' then
    local k = math.min(1, (CR.t - CR.t0) / SHAKE)
    local amp = 0.05 * (1 - 0.35 * k)
    card.T.r = amp * math.sin(CR.t * 42)
    card.T.x = card.area.T.x + card.area.T.w / 2 + amp * 12 * math.sin(CR.t * 55)
  elseif CR.phase == 'shown' then
    card.T.r = 0.004 * math.sin(CR.t * 2.4)
  end
  if CR.flash and CR.flash > 0 then CR.flash = math.max(0, CR.flash - dt * 4) end
end

function CR.draw_overlay()
  if not CR.moment or not CR.flash or CR.flash <= 0 then return end
  love.graphics.push('all')
  love.graphics.origin(); love.graphics.setShader(); love.graphics.setCanvas()
  love.graphics.setScissor(); love.graphics.setStencilTest(); love.graphics.setBlendMode('alpha')
  love.graphics.setColor(1, 1, 1, CR.flash)
  love.graphics.rectangle('fill', 0, 0, love.graphics.getWidth(), love.graphics.getHeight())
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.pop()
end

-- ---------- the shop button ----------
function CR.install_shop_button()
  if CR.shop_hooked or not (G and G.UIDEF and G.UIDEF.shop) then return end
  CR.shop_hooked = true
  local orig = G.UIDEF.shop
  G.UIDEF.shop = function(...)
    local t = orig(...)
    pcall(function()
      local done = false
      local function walk(node)
        if done or type(node) ~= 'table' then return end
        local nodes = node.nodes
        if type(nodes) == 'table' then
          for i, child in ipairs(nodes) do
            if type(child) == 'table' and child.config and child.config.button == 'reroll_shop' then
              child.config.id = 'cg_reroll_anchor'      -- just a handle; the layout is untouched
              done = true
              return
            end
            walk(child)
          end
        end
      end
      walk(t)
    end)
    return t
  end
  if __WEB then __WEB.emit('reveal', 'shop button installed') end
end

-- ---------- the floating Generate button (bonded to the shop's own Reroll button) ----------
function CR.button_box(anchor)
  return UIBox{
    definition = { n = G.UIT.ROOT, config = { align = 'cm', colour = G.C.CLEAR, padding = 0.02 }, nodes = {
      { n = G.UIT.C, config = { id = 'cg_generate_button', align = 'cm', minw = 2.8, minh = 1.4, r = 0.15,
        colour = G.C.PURPLE, button = 'cg_generate', hover = true, shadow = true }, nodes = {
        { n = G.UIT.R, config = { align = 'cm', padding = 0.05 }, nodes = {
          { n = G.UIT.T, config = { text = 'Generate', scale = 0.4, colour = G.C.WHITE, shadow = true } } } },
        { n = G.UIT.R, config = { align = 'cm', padding = 0.02 }, nodes = {
          { n = G.UIT.T, config = { text = 'a Joker', scale = 0.32, colour = G.C.WHITE, shadow = true } } } },
      } },
    } },
    config = { align = 'cm', offset = { x = 0, y = -1.62 }, major = anchor, bond = 'Weak' } }
end

function CR.update_shop_button()
  if not (G and G.STATE and G.HUD) then return end
  local in_shop = G.STATE == G.STATES.SHOP
  if not in_shop then
    if CR.btn then pcall(function() CR.btn:remove() end) CR.btn = nil end
    return
  end
  if CR.btn then return end
  -- the shop's buttons live in G.shop (built by Game:update_shop), not in the HUD
  local node
  for _, parent in ipairs({ G.shop, G.HUD, G.OVERLAY_MENU }) do
    if not node and parent and parent.get_UIE_by_ID then
      node = parent:get_UIE_by_ID('cg_reroll_anchor') or parent:get_UIE_by_ID('next_round_button')
    end
  end
  if node then
    CR.btn = CR.button_box(node)
    if __WEB then __WEB.emit('reveal', 'shop button placed (anchored)') end
  elseif G.shop then
    -- fallback: if the shop's own buttons cannot be found, sit under the shop panel's left column anyway
    CR.btn = CR.button_box(G.shop)
    if __WEB then __WEB.emit('reveal', 'shop button placed (fallback)') end
  end
end

-- ---------- install hooks ----------
function CR.install()
  if CR.installed then return end
  CR.installed = true
  pcall(CR.late_init)
  local _update, _draw = love.update, love.draw
  love.update = function(dt)
    if _update then _update(dt) end
    pcall(CR.update, dt)
    pcall(CR.update_shop_button)
  end
  love.draw = function() if _draw then _draw() end pcall(CR.draw_overlay) end
  if __WEB then __WEB.emit('reveal', 'installed') end
end

-- ---------- everything that needs the game to exist ----------
function CR.late_init()
  if CR.late_done then return end
  CR.late_done = true
  G.FUNCS = G.FUNCS or {}
-- ---------- game functions ----------
G.FUNCS.cg_generate = function(e)
  if CR.moment then return end
  if G.STATE ~= G.STATES.SHOP then return end
  CR.open()
  if __WEB then __WEB.emit('cardrequest', CR.topic) end      -- the page asks the player's own computer
end
G.FUNCS.cg_take = function(e)
  local spec, key = CR.spec, CR.key
  if not (spec and key) then CR.close() return end
  pcall(function()
    local card = Card(G.jokers.T.x + G.jokers.T.w / 2, G.jokers.T.y, G.CARD_W, G.CARD_H, G.P_CARDS.empty,
      G.P_CENTERS[key], { bypass_discovery_center = true })
    card.ability.cg_spec = spec
    G.jokers:emplace(card)
    card:add_to_deck()
    G.jokers:unhighlight_all()
  end)
  if play_sound then pcall(play_sound, 'button', 1, 0.8) end
  CR.close()
  if __WEB then __WEB.emit('reveal', 'taken ' .. tostring(spec.name)) end
end
G.FUNCS.cg_close = function(e) CR.close() end

  if __WEB and __WEB.handlers then
  __WEB.handlers.cardpending = function(d)
    local topic = type(d) == 'table' and d.topic or d
    CR.current_topic = topic
    if not CR.moment then CR.open(topic) end
  end
  __WEB.handlers.cardreveal = function(spec) CR.deliver(spec) end
  __WEB.handlers.cardhide = function() CR.close() end
  __WEB.handlers.settopic = function(d) CR.current_topic = (type(d) == 'table' and d.topic) or d end
  end
end

