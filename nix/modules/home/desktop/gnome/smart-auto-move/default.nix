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
        enabled-extensions = [ "smart-auto-move@khimaros.com" ];
      };

      "org/gnome/shell/extensions/smart-auto-move" = {
      };
    };

    home.packages = with pkgs.gnomeExtensions; [ smart-auto-move ];
  };
}
