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
    home.packages = with pkgs.gnomeExtensions; [ pano ];

    dconf.settings = {
      "org/gnome/shell" = {
        enabled-extensions = [ "pano@elhan.io" ];
      };

      "org/gnome/shell/extensions/pano" = { };
    };
  };
}
