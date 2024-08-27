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
        enabled-extensions = [ "rclone-manager@germanztz.com" ];
      };
    };

    home.packages = with pkgs; [ rclone ] ++ (with pkgs.gnomeExtensions; [ rclone-manager ]);
  };
}
