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
    home.packages = with pkgs.gnomeExtensions; [ useless-gaps ];

    dconf.settings = {
      # "org/gnome/shell" = {
      #   enabled-extensions = [ "useless-gaps@pimsnel.com" ];
      # };

      "org/gnome/shell/extensions/useless-gaps" = {
        gap-size = 16;
        margin-bottom = 16;
        margin-left = 16;
        margin-right = 16;
        margin-top = 16;
      };
    };
  };
}
