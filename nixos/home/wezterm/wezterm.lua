local wezterm = require 'wezterm'

if wezterm.config_builder then
  config = wezterm.config_builder()

  config.front_end = "WebGpu"
  config.webgpu_power_preference = "HighPerformance"
  config.color_scheme = 'catppuccin-frappe'

  config.window_decorations = "RESIZE"
  config.enable_tab_bar = false
  config.window_close_confirmation = "NeverPrompt"

  config.default_prog = {
    "zellij"
  }

  config.window_background_opacity = 0.9
  config.macos_window_background_blur = 32

  config.font = wezterm.font 'Monaspace Neon'
  config.font_size = 16.0

  -- Clickable Links
  config.hyperlink_rules = wezterm.default_hyperlink_rules()

  return config
end
