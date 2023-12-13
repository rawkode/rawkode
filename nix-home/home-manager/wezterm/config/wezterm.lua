local wezterm = require 'wezterm'

function scheme_for_appearance(appearance)
    if appearance:find 'Dark' then
        return "rose-pine"
    else
        return "rose-pine-dawn"
    end
end

if wezterm.config_builder then
    config = wezterm.config_builder()

    actions = wezterm.action

    config.automatically_reload_config = true

    config.front_end = "WebGpu"
    config.webgpu_power_preference = "HighPerformance"

    config.window_decorations = "RESIZE"

    config.enable_tab_bar = true
    config.window_close_confirmation = "NeverPrompt"

    config.color_scheme = scheme_for_appearance(wezterm.gui.get_appearance())
    config.window_background_opacity = 0.9
    config.macos_window_background_blur = 32

    config.font = wezterm.font 'Monaspace Argon'
    config.font_size = 24.0

    config.keys = {{
        key = "P",
        mods = "CMD",
        action = actions.ActivateCommandPalette
    }, {
        key = 'p',
        mods = 'CMD',
        action = actions.PaneSelect
    }, {
        key = 'z',
        mods = 'CMD',
        action = actions.TogglePaneZoomState
    }, {
        key = ']',
        mods = 'ALT',
        action = actions.ActivatePaneDirection 'Next'
    }, {
        key = '[',
        mods = 'ALT',
        action = actions.ActivatePaneDirection 'Prev'
    }}

    return config

end
