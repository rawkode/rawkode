{ inputs, system, ... }:
{
  home.packages = [
    inputs.wezterm.packages.${system}.default
  ];

  xdg.configFile."wezterm" = {
    source = ./config;
    recursive = true;
  };
}
