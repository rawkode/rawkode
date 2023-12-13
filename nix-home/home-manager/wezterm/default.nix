{ pkgs, ... }: {
  xdg.configFile = {
    wezterm.source = ./config;
  };
}
