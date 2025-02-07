{ pkgs, ... }:
{
  home.packages = with pkgs; [
    wezterm
  ];

  xdg.configFile."wezterm" = {
    source = ./config;
    recursive = true;
  };
}
