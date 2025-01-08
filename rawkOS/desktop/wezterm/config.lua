local wezterm = require 'wezterm'

if wezterm.config_builder then
    config = wezterm.config_builder()

		-- While we have access to appearance.is_dark, we can't use it
		-- that successfully yet because we can't notify Zellij or fish
		-- of the color change and everything looks weird.
		config.color_scheme = 'catppuccin-mocha'

    config.enable_kitty_graphics = true
    config.automatically_reload_config = true
    config.detect_password_input = true
    config.hide_mouse_cursor_when_typing = true
    config.adjust_window_size_when_changing_font_size = false

    config.leader = {key = 'a', mods = 'CTRL', timeout_milliseconds = 1000}

    --config.xcursor_theme="Catppuccin-Mocha-Maroon-Cursors"

    config.front_end = "OpenGL"
    config.enable_wayland = true
    config.webgpu_power_preference = "HighPerformance"

    config.enable_tab_bar = false
    config.window_decorations = "RESIZE"
    config.window_close_confirmation = "NeverPrompt"

    config.window_background_opacity = 1

    config.window_frame = {
        font = wezterm.font({family = 'MonaspiceAr Nerd Font Mono', weight = 'Bold'}),
        font_size = 11
    }

    config.font = wezterm.font_with_fallback {
        'MonaspiceNe Nerd Font Mono',
    }
    config.font_size = 16.0

    -- Clickable Links
    config.hyperlink_rules = wezterm.default_hyperlink_rules()

    table.insert(config.hyperlink_rules, {
        regex = [[["]?([\w\d]{1}[-\w\d]+)(/){1}([-\w\d\.]+)["]?]],
        format = 'https://www.github.com/$1/$3'
    })

    return config
end
