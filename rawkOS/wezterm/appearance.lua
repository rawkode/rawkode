local wezterm = require 'wezterm'
local module = {}

-- Check if the system appearance is dark
function module.is_dark()
    local appearance = wezterm.gui.get_appearance()
    return appearance:find("Dark") ~= nil
end

-- Get the appropriate color scheme based on appearance
function module.scheme_for_appearance()
    if module.is_dark() then
        return "Catppuccin Macchiato"
    end
    return "Catppuccin Latte"
end

return module
