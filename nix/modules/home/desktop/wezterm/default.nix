{ pkgs, ... }:
{
  programs.wezterm = {
    enable = true;
    package = pkgs.wezterm;
  };

  xdg.configFile."wezterm" = {
    source = ./config;
    recursive = true;
  };
}
