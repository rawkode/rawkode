local wezterm = require 'wezterm'
local appearance = require 'appearance'

if wezterm.config_builder then
    config = wezterm.config_builder()

    -- Dynamically set color scheme based on system appearance
    config.color_scheme = appearance.scheme_for_appearance()
    
    -- Force WezTerm to check appearance changes more frequently
    wezterm.on("window-config-reloaded", function(window, pane)
        window:set_config_overrides({
            color_scheme = appearance.scheme_for_appearance(),
        })
    end)

    config.mux_enable_ssh_agent = false
    config.enable_kitty_graphics = true
    config.automatically_reload_config = true
    config.detect_password_input = true
    config.hide_mouse_cursor_when_typing = true
    config.adjust_window_size_when_changing_font_size = false

    -- config.xcursor_theme="Catppuccin-Mocha-Maroon-Cursors"

    config.front_end = "OpenGL"
    config.enable_wayland = true
    config.webgpu_power_preference = "HighPerformance"

    config.enable_tab_bar = false
    config.window_decorations = "RESIZE"
    config.window_close_confirmation = "NeverPrompt"

    config.window_background_opacity = 1

    config.window_frame = {
        font = wezterm.font({
            family = 'MonaspiceAr Nerd Font Mono',
            weight = 'Bold'
        }),
        font_size = 12.0
    }

    config.font = wezterm.font_with_fallback {'MonaspiceNe Nerd Font Mono'}
    config.font_size = 16.0

    -- Clickable Links
    config.hyperlink_rules = wezterm.default_hyperlink_rules()

    table.insert(config.hyperlink_rules, {
        regex = [[["]?([\w\d]{1}[-\w\d]+)(/){1}([-\w\d\.]+)["]?]],
        format = 'https://www.github.com/$1/$3'
    })

		-- We want these keys to work for Zellij
    config.keys = {{
        key = 'PageUp',
        mods = 'CTRL',
        action = wezterm.action.DisableDefaultAssignment
    }, {
        key = 'PageDown',
        mods = 'CTRL',
        action = wezterm.action.DisableDefaultAssignment
    }}

    return config
end
