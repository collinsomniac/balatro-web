-- cardgen.lua — turns a JSON card spec (written by an LLM) into a real Balatro joker, at runtime.
-- The card is registered exactly like a vanilla joker (centres table, pool, localization, atlas position) and
-- its effect is evaluated by a small declarative interpreter, so nothing here executes model-written Lua.
-- Part of the web port; contains nothing from the game.
local CG = { version = 'cardgen 0.1', cards = {} }
_G.__CARDGEN = CG

local SUITS = { Hearts = 'Hearts', Diamonds = 'Diamonds', Spades = 'Spades', Clubs = 'Clubs' }
local RARITY_ORDER = { 1, 2, 3, 4 }

-- ---------- conditions ----------
local function count_suit(cards, suit)
  local n = 0
  for _, c in ipairs(cards or {}) do if c:is_suit(suit, true) then n = n + 1 end end
  return n
end
local function count_faces(cards)
  local n = 0
  for _, c in ipairs(cards or {}) do if c:is_face(true) then n = n + 1 end end
  return n
end
local function count_rank(cards, rank)
  local n = 0
  for _, c in ipairs(cards or {}) do if c:get_id() == rank then n = n + 1 end end
  return n
end

local function check(cond, self, context)
  local c = context or {}
  local hand = c.scoring_hand or c.full_hand or {}
  local G_ = _G.G
  local t = cond.type
  if t == 'always' then return true
  elseif t == 'hand_type' then
    return c.scoring_name == cond.value or (c.poker_hands and c.poker_hands[cond.value] ~= nil)
  elseif t == 'suit_count' then return count_suit(hand, cond.value) >= (cond.count or 1)
  elseif t == 'face_count' then return count_faces(hand) >= (cond.count or 1)
  elseif t == 'rank_count' then return count_rank(hand, cond.rank) >= (cond.count or 1)
  elseif t == 'cards_played_at_least' then return #(c.full_hand or hand) >= (cond.value or 1)
  elseif t == 'money_at_least' then return (G_.GAME.dollars or 0) >= (cond.value or 1)
  elseif t == 'money_at_most' then return (G_.GAME.dollars or 0) <= (cond.value or 1)
  elseif t == 'discards_left_at_most' then
    return (G_.GAME.current_round and G_.GAME.current_round.discards_left or 0) <= (cond.value or 1)
  elseif t == 'hands_left_at_most' then
    return (G_.GAME.current_round and G_.GAME.current_round.hands_left or 0) <= (cond.value or 1)
  elseif t == 'jokers_at_least' then return #(G_.jokers.cards or {}) >= (cond.value or 1)
  elseif t == 'deck_size_at_least' then return (#G_.deck.cards or 0) >= (cond.value or 1)
  elseif t == 'every_nth' then
    self.ability.extra = self.ability.extra or {}
    self.ability.extra.cg_count = (self.ability.extra.cg_count or 0) + 1
    return (self.ability.extra.cg_count % (cond.value or 2)) == 0
  elseif t == 'probability' then
    local odds = cond.value or 4
    local normal = (G_.GAME.probabilities and G_.GAME.probabilities.normal) or 1
    self.ability.extra = self.ability.extra or {}
    local roll = pseudorandom('cg_' .. tostring(self.ability.center_key or self.ability.name) .. tostring(self.sort_id))
    return roll < (normal / odds)
  end
  return false
end

-- ---------- effects ----------
local function apply(eff, self, context, out)
  local c = context or {}
  local hand = c.full_hand or c.scoring_hand or {}
  local G_ = _G.G
  local v = eff.value or 0
  local t = eff.op

  if t == 'add_mult' then out.mult_mod = (out.mult_mod or 0) + v
  elseif t == 'add_chips' then out.chips_mod = (out.chips_mod or 0) + v
  elseif t == 'xmult' then out.Xmult_mod = (out.Xmult_mod or 1) * v
  elseif t == 'add_money' then out.dollars = (out.dollars or 0) + v
  elseif t == 'add_hand_size' then G_.GAME.round_resets.hand_size = (G_.GAME.round_resets.hand_size or 0) + v
  elseif t == 'add_discards' then
    G_.GAME.current_round.discards_left = (G_.GAME.current_round.discards_left or 0) + v
  elseif t == 'add_hands' then G_.GAME.current_round.hands_left = (G_.GAME.current_round.hands_left or 0) + v
  elseif t == 'mult_per_played_card' then out.mult_mod = (out.mult_mod or 0) + (#hand * v)
  elseif t == 'mult_per_face' then out.mult_mod = (out.mult_mod or 0) + (count_faces(hand) * v)
  elseif t == 'mult_per_suit' then out.mult_mod = (out.mult_mod or 0) + (count_suit(hand, eff.suit) * v)
  elseif t == 'xmult_per_joker' then out.Xmult_mod = (out.Xmult_mod or 1) * (v ^ math.max(1, #(G_.jokers.cards or {})))
  elseif t == 'xmult_per_money' then
    out.Xmult_mod = (out.Xmult_mod or 1) * (v ^ math.floor((G_.GAME.dollars or 0) / (eff.per or 5)))
  elseif t == 'scale_mult' then            -- grows every trigger: +rate each time, worth value*count
    self.ability.extra = self.ability.extra or {}
    self.ability.extra.cg_scale = (self.ability.extra.cg_scale or 0) + (eff.rate or 1)
    out.mult_mod = (out.mult_mod or 0) + (self.ability.extra.cg_scale * v)
  elseif t == 'scale_chips' then
    self.ability.extra = self.ability.extra or {}
    self.ability.extra.cg_scale = (self.ability.extra.cg_scale or 0) + (eff.rate or 1)
    out.chips_mod = (out.chips_mod or 0) + (self.ability.extra.cg_scale * v)
  elseif eff and eff.op == nil then
    -- ignore unknown ops rather than erroring a live run
  end
  return out
end

local function message_for(spec, out)
  if out.dollars then return localize { type = 'variable', key = 'a_money', vars = { out.dollars } } end
  if out.Xmult_mod then
    return localize { type = 'variable', key = 'a_xmult', vars = { out.Xmult_mod } }
  end
  if out.mult_mod then return localize { type = 'variable', key = 'a_mult', vars = { out.mult_mod } } end
  if out.chips_mod then return localize { type = 'variable', key = 'a_chips', vars = { out.chips_mod } } end
  return spec and spec.name or nil
end

-- ---------- interpretation ----------
function CG.evaluate(self, context)
  local spec = self.ability.cg_spec
  if not spec or not spec.effect then return nil end
  local trig = spec.effect.trigger or 'joker_main'
  local c = context or {}
  local ok_ctx
  if trig == 'joker_main' then ok_ctx = c.joker_main
  elseif trig == 'individual' then ok_ctx = c.individual
  elseif trig == 'end_of_round' then ok_ctx = c.end_of_round
  elseif trig == 'discard' then ok_ctx = c.discard
  elseif trig == 'hand_played' then ok_ctx = c.hand_played
  elseif trig == 'independent' then ok_ctx = not (c.before or c.after or c.joker_main) and c.cardarea == G.jokers
  else ok_ctx = c.joker_main end
  if not ok_ctx then return nil end
  for _, cond in ipairs(spec.effect.conditions or {}) do
    if not check(cond, self, context) then return nil end
  end
  local out = {}
  for _, eff in ipairs(spec.effect.effects or {}) do apply(eff, self, context, out) end
  if not (spec.effect.effects and #spec.effect.effects > 0) then return nil end
  out.card = self
  out.message = message_for(spec, out)
  out.colour = out.Xmult_mod and G.C.RED or (out.dollars and G.C.MONEY or G.C.MULT)
  return out
end

-- ---------- registration ----------
local function base_key(name)
  return 'j_' .. (tostring(name):lower():gsub('[^%w]+', '_'):gsub('^_+', ''):gsub('_+$', ''))
end

function CG.register(spec)
  if type(spec) ~= 'table' or not spec.name then return nil, 'spec needs a name' end
  local key = spec.key and tostring(spec.key) or base_key(spec.name)
  if key:sub(1, 2) ~= 'j_' then key = 'j_' .. key end
  spec.key = key

  local rarity = math.max(1, math.min(4, tonumber(spec.rarity) or 1))
  local pos = (type(spec.art) == 'table' and type(spec.art.pos) == 'table') and spec.art.pos or { x = 0, y = 0 }
  local center = {
    order = #G.P_CENTER_POOLS.Joker + 1,
    unlocked = true, discovered = true, no_collection = false, start_alerted = true,
    blueprint_compat = true, perishable_compat = true, eternal_compat = true,
    rarity = rarity, cost = tonumber(spec.cost) or ({ 4, 6, 8, 10 })[rarity],
    name = spec.name, pos = { x = pos.x or 0, y = pos.y or 0 }, set = 'Joker',
    effect = spec.effect_label or 'Mult', cost_mult = 1.0,
    config = {}, cg_spec = spec,
  }
  G.P_CENTERS[key] = center
  table.insert(G.P_CENTER_POOLS.Joker, center)
  G.localization.descriptions.Joker[key] = {
    name = spec.name,
    text = spec.text or { 'Generated card' },
    unlock = spec.flavor or nil,
  }
  CG.cards[key] = spec

  -- the atlas already has 5 rows of jokers; reuse a themed slot as the placeholder art
  local atlas = G.ASSET_ATLAS['Jokers']
  if atlas then
    local rows = math.floor(atlas.image:getHeight() / atlas.image:getWidth() * 10 + 0.5) -- 10 columns
    local _ = rows
  end
  return key
end

function CG.spawn(key, where)
  local card = Card(G.jokers.T.x + G.jokers.T.w / 2, G.jokers.T.y, G.CARD_W, G.CARD_H, nil, G.P_CENTERS[key], { bypass_discovery_center = true })
  if where == 'deck' then
    card:add_to_deck()
    G.deck:emplace(card)
  else
    G.jokers:emplace(card)
    card:add_to_deck()
  end
  return card
end

-- Patch the game's joker evaluator once the game has loaded.
function CG.install()
  if CG.installed then return end
  local _calc = Card.calculate_joker
  Card.calculate_joker = function(self, context)
    local base = _calc(self, context)
    if self.ability and self.ability.set == 'Joker' and self.ability.cg_spec then
      local extra = CG.evaluate(self, context)
      if extra then
        if base and (base.mult_mod or base.chips_mod or base.Xmult_mod or base.dollars) then
          base.mult_mod = (base.mult_mod or 0) + (extra.mult_mod or 0)
          base.chips_mod = (base.chips_mod or 0) + (extra.chips_mod or 0)
          base.Xmult_mod = (base.Xmult_mod or 1) * (extra.Xmult_mod or 1)
          base.dollars = (base.dollars or 0) + (extra.dollars or 0)
          return base
        end
        return extra
      end
    end
    return base
  end
  CG.installed = true
  CG.emit('cardgen installed')
end

function CG.emit(msg) if __WEB and __WEB.emit then __WEB.emit('cardgen', msg) end end

-- Bridge: the page sends {"c":"cardadd","d":<spec>}
if __WEB and __WEB.handlers then
  __WEB.handlers.cardadd = function(spec)
    local ok, key = pcall(CG.register, spec)
    if not ok then CG.emit('register failed: ' .. tostring(key)) return end
    CG.install()
    local spawned = false
    if _G.G and G.STATE and G.jokers then
      pcall(function() CG.spawn(key) spawned = true end)
    end
    CG.emit(string.format('added %s (%s) spawned=%s', key, tostring(spec and spec.name), tostring(spawned)))
  end
end

-- fall back to an early install hook if the card module is already loaded
if Card and Card.calculate_joker then CG.install() end
