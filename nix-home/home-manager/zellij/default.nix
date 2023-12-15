{ pkgs, ... }: {
  # We don't install here because we need a reliable
  # path for wezterm
  #   home.packages = with pkgs; [
  # 	zellij
  # ];

  xdg.configFile = {
    zellij.source = ./config;
  };
}
