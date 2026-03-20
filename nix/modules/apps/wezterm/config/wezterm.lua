local wezterm = require 'wezterm'

if wezterm.config_builder then
    config = wezterm.config_builder()

    config.color_scheme = 'rose-pine'

    config.enable_kitty_graphics = true
    config.automatically_reload_config = true
    config.detect_password_input = true
    config.hide_mouse_cursor_when_typing = true
    config.adjust_window_size_when_changing_font_size = false

    config.use_fancy_tab_bar = true
		config.window_decorations = 'RESIZE|INTEGRATED_BUTTONS'

    config.front_end = "OpenGL"
    config.enable_wayland = true
    config.webgpu_power_preference = "HighPerformance"

		config.window_padding = {
		  left = 64,
		  right = 64,
		  top = 64,
		  bottom = 64,
		}

    config.window_close_confirmation = "NeverPrompt"

    config.pane_focus_follows_mouse = true

		config.macos_window_background_blur = 20
		config.window_background_opacity = 0.92

    config.window_frame = {
        font = wezterm.font({
            family = 'Monaspace Neon',
            weight = 'Bold'
        }),
        font_size = 14
    }
    config.keys = {{
	    key = 'p',
	    mods = 'CMD',
	    action = wezterm.action.ActivateCommandPalette,
	  }}

    config.font = wezterm.font_with_fallback {'Monaspace Neon', 'Symbols Nerd Font Mono'}
    config.font_size = 16.0

    -- Clickable Links
    config.hyperlink_rules = wezterm.default_hyperlink_rules()

    table.insert(config.hyperlink_rules, {
        regex = [[["]?([\w\d]{1}[-\w\d]+)(/){1}([-\w\d\.]+)["]?]],
        format = 'https://www.github.com/$1/$3'
    })

    -- Disappearing cursor fix
    -- https://github.com/wez/wezterm/issues/1742#issuecomment-1075333507
    -- local xcursor_size = nil
    -- local xcursor_theme = nil

    -- local success, stdout, stderr = wezterm.run_child_process({"gsettings", "get", "org.gnome.desktop.interface", "cursor-theme"})
    -- if success then
    --   config.xcursor_theme = stdout:gsub("'(.+)'\n", "%1")
    -- end

    -- local success, stdout, stderr = wezterm.run_child_process({"gsettings", "get", "org.gnome.desktop.interface", "cursor-size"})
    -- if success then
    --   config.xcursor_size = tonumber(stdout)
    -- end

    return config
end
