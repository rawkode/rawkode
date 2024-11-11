{ pkgs, ... }: {
  xdg.configFile."wezterm" = {
    source = ./config;
    recursive = true;
  };
}
