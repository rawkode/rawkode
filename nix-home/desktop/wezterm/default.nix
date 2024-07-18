{ ... }:
{
  programs.wezterm.enable = true;
	xdg.configFile."wezterm/wezterm.lua".source = ./config.lua;
}
