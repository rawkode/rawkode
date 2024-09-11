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
    home.packages = with pkgs; [ rawkOS.draw-on-your-screen ];

    dconf.settings = {
      "org/gnome/shell" = {
        enabled-extensions = [ "draw-on-your-screen2@zhrexl.github.com" ];
      };

      "org/gnome/shell/extensions/draw-on-your-screen" = {
        erase-drawings = [ "<Super><Shift>d" ];
        toggle-drawing = [ "<Super>d" ];
        toggle-modal = [ "<Control><Alt><Super>d" ];
      };
    };
  };
}
