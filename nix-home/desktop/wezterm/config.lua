local wezterm = require 'wezterm'

function scheme_for_appearance(appearance)
  return "catppuccin-mocha"
end

if wezterm.config_builder then
  config = wezterm.config_builder()

  -- config.front_end = "WebGpu"
  -- config.webgpu_power_preference = "HighPerformance"

  -- config.window_decorations = "RESIZE"
  -- config.enable_tab_bar = true
  config.window_close_confirmation = "NeverPrompt"

  config.default_prog = {
    "/home/rawkode/.nix-profile/bin/zellij"
  }

  config.color_scheme = scheme_for_appearance(wezterm.gui.get_appearance())

  config.font = wezterm.font 'Monaspace Neon'
  config.font_size = 24.0

	-- Clickable Links
	config.hyperlink_rules = wezterm.default_hyperlink_rules()

  return config
end
