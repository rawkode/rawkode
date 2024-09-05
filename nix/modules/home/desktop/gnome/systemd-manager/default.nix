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
    home.packages = with pkgs.gnomeExtensions; [ systemd-manager ];

    dconf.settings = {
      "org/gnome/shell" = {
        enabled-extensions = [ "systemd-manager@hardpixel.eu" ];
      };
    };
  };
}
