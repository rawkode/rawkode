local wezterm = require 'wezterm'
local module = {}

function module.scheme_for_appearance()
    local appearance = wezterm.gui.get_appearance()
    if appearance:find("Dark") then
        return "Catppuccin Macchiato"
    end
    return "Catppuccin Latte"
end

return module
