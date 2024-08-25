{ inputs, pkgs, ... }:
{
  programs.wezterm = {
    enable = true;
    package = inputs.wezterm.packages.${pkgs.system}.default;
  };

  xdg.configFile."wezterm" = {
    source = ./config;
    recursive = true;
  };
}
