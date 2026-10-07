-- Boot loader: this tiny archive is the game's "source". It mounts the player's own archive, then our
-- patch overlay (which shadows the files we modify), then runs the real main.lua.
local PATCHES, GAME = 'web_patch.zip', 'game.zip'

local ok, err = love.filesystem.mount(GAME, '')
if not ok then error('could not mount ' .. GAME .. ': ' .. tostring(err)) end
ok, err = love.filesystem.mount(PATCHES, '')
if not ok then error('could not mount ' .. PATCHES .. ': ' .. tostring(err)) end

local chunk, lerr = love.filesystem.load('main.lua')
if not chunk then error('could not load the game: ' .. tostring(lerr)) end
return chunk()
