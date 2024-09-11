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
    home.packages = with pkgs.gnomeExtensions; [ blur-my-shell ];

    dconf.settings = {
      "org/gnome/shell" = {
        enabled-extensions = [ "blur-my-shell@aunetx" ];
      };

      "org/gnome/shell/extensions/blur-my-shell" = { };
    };
  };
}
