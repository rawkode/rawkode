{ lib, pkgs, ... }:
with lib;
{
  dconf.settings = {
    "org/gnome/shell" = {
      enabled-extensions = [ "desktop-cube@schneegans.github.com" ];
    };

    "org/gnome/shell/extensions/desktop-cube" = {
      do-explode = true;
      enable-panel-dragging = true;
      per-monitor-perspective = true;
      window-parallax = 0.5;
      workpace-separation = 64;
    };
  };

  home.packages = with pkgs.gnomeExtensions; [ desktop-cube ];
}
