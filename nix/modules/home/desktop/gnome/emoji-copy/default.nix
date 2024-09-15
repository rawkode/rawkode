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
        enabled-extensions = [ "emoji-copy@felipeftn" ];
      };
    };

    home.packages = with pkgs.gnomeExtensions; [ emoji-copy ];
  };
}
