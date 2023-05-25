local wezterm = require 'wezterm'

function scheme_for_appearance(appearance)
  if appearance:find("Dark") then
    return "Catppuccin Mocha"
  else
    return "Catppuccin Frappe"
  end
end

if wezterm.config_builder then
  config = wezterm.config_builder()

  config.window_decorations = "RESIZE"
  config.enable_tab_bar = false
  config.window_close_confirmation = "NeverPrompt"

  config.default_prog = {
    "/opt/homebrew/bin/zellij"
  }

  config.color_scheme = scheme_for_appearance(wezterm.gui.get_appearance())
  config.window_background_opacity = 0.9
  config.macos_window_background_blur = 32

  config.font = wezterm.font 'MonoLisa'
  config.font_size = 22.0

  return config
end
