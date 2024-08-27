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
        enabled-extensions = [ "compiz-windows-effect@hermes83.github.com" ];
      };

      "org/gnome/shell/extensions/com/github/hermes83/compiz-windows-effect" = {
        friction = 3.4;
        mass = 71.0;
        resize-effect = true;
        speedup-factor-divider = 12.1;
        spring-k = 4.0;
      };
    };

    home.packages = with pkgs.gnomeExtensions; [ compiz-windows-effect ];
  };
}
