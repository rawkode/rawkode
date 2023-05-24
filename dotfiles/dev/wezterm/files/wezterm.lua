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
  config.hide_tab_bar_if_only_one_tab = true
  config.window_close_confirmation = "NeverPrompt"

  config.default_prog = {
    "/opt/homebrew/bin/zellij"
  }

  config.color_scheme = scheme_for_appearance(wezterm.gui.get_appearance())
  config.macos_window_background_blur = 10

  config.font = wezterm.font 'MonoLisa'
  config.font_size = 24.0

  return config
end

