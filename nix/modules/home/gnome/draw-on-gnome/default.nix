{ lib, pkgs, ... }:
with lib;
{
  home.packages = with pkgs; [ rawkOS.draw-on-gnome ];

  dconf.settings = {
    "org/gnome/shell" = {
      enabled-extensions = [ "draw-on-gnome@daveprowse.github.io" ];
    };

    "org/gnome/shell/extensions/draw-on-gnome" = {
      erase-drawings = [ "<Super><Shift>d" ];
      toggle-drawing = [ "<Super>d" ];
      toggle-modal = [ "<Control><Alt><Super>d" ];
    };
  };
}
