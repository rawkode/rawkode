{
  lib,
  osConfig ? { },
  pkgs,
  ...
}:
with lib;
let
  cfg = osConfig.rawkOS.desktop.gnome;
in
{
  config = mkIf cfg.enable {
    dconf.settings = {
      "org/gnome/shell" = {
        enabled-extensions = [ "transparent-window-moving@noobsai.github.com" ];
      };

      "org/gnome/shell/extensions/transparent-window-moving" = {
        window-opacity = 192;
      };
    };

    home.packages = with pkgs.gnomeExtensions; [ transparent-window-moving ];
  };
}
