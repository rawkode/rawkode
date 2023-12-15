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

    config.default_prog = {"/run/current-system/sw/bin/zellij"}

    config.automatically_reload_config = true

    config.front_end = "WebGpu"
    config.webgpu_power_preference = "HighPerformance"

    config.window_decorations = "RESIZE"

    config.enable_tab_bar = true
    config.hide_tab_bar_if_only_one_tab = true
    config.use_fancy_tab_bar = false

    config.window_close_confirmation = "NeverPrompt"

    config.color_scheme = scheme_for_appearance(wezterm.gui.get_appearance())
    config.window_background_opacity = 0.9
    config.macos_window_background_blur = 32

    config.font = wezterm.font 'Monaspace Argon'
    config.font_size = 24.0

    config.disable_default_key_bindings = true

    config.keys = {{
        key = 'v',
        mods = 'CMD',
        action = actions.PasteFrom 'Clipboard'
    }, {
        key = 'c',
        mods = 'CMD',
        action = actions.CopyTo 'ClipboardAndPrimarySelection'
    }, {
        key = "q",
        mods = "CMD",
        action = actions.QuitApplication
    }, {
        key = "P",
        mods = "CMD",
        action = actions.ActivateCommandPalette
    }}

    return config

end
