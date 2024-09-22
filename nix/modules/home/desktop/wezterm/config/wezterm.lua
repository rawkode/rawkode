local wezterm = require 'wezterm'

if wezterm.config_builder then
    config = wezterm.config_builder()

		config.color_scheme = 'catppuccin-frappe'

    config.automatically_reload_config = true
    config.detect_password_input = true
    config.hide_mouse_cursor_when_typing = true
    config.adjust_window_size_when_changing_font_size = false

    config.leader = {key = 'a', mods = 'CTRL', timeout_milliseconds = 1000}

    config.front_end = "WebGpu"
    config.enable_wayland = false
    config.webgpu_power_preference = "HighPerformance"

    config.enable_tab_bar = false
    config.window_decorations = "RESIZE"
    -- config.window_close_confirmation = "NeverPrompt"
		config.window_close_confirmation = 'AlwaysPrompt'

    config.window_background_opacity = 1

    config.window_frame = {
        font = wezterm.font({family = 'Monaspace Neon', weight = 'Bold'}),
        font_size = 11
    }

    config.default_prog = {"/home/rawkode/.nix-profile/bin/zellij"}

    config.font = wezterm.font_with_fallback {
        'Monaspace Neon', 'Symbols Nerd Font Mono'
    }
    config.font_size = 12.0

    -- Clickable Links
    config.hyperlink_rules = wezterm.default_hyperlink_rules()

    table.insert(config.hyperlink_rules, {
        regex = [[["]?([\w\d]{1}[-\w\d]+)(/){1}([-\w\d\.]+)["]?]],
        format = 'https://www.github.com/$1/$3'
    })

    return config
end
