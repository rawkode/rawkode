local wezterm = require 'wezterm'
local appearance = require 'appearance'

if wezterm.config_builder then
    config = wezterm.config_builder()

    -- There's no decent way to have Zellij or fish
		-- update yet; so pending
    if appearance.is_dark() then
      config.color_scheme = 'catppuccin-latte'
    else
      config.color_scheme = 'catppuccin-frappe'
    end

    config.automatically_reload_config = true
    config.detect_password_input = true
    config.hide_mouse_cursor_when_typing = true
    config.adjust_window_size_when_changing_font_size = false

    config.leader = {key = 'a', mods = 'CTRL', timeout_milliseconds = 1000}

    config.front_end = "OpenGL"
    config.enable_wayland = true
    config.webgpu_power_preference = "HighPerformance"

    config.enable_tab_bar = false
    -- config.window_decorations = "RESIZE"
    config.window_close_confirmation = "NeverPrompt"

    config.window_background_opacity = 1

    config.window_frame = {
        font = wezterm.font({family = 'Monaspace Argon', weight = 'Bold'}),
        font_size = 11
    }

    config.font = wezterm.font_with_fallback {
        'Monaspace Neon', 'Symbols Nerd Font Mono'
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
