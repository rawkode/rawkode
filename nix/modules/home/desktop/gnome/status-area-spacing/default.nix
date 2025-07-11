{ lib, pkgs, ... }:
with lib;
{

  dconf.settings = {
    "org/gnome/shell" = {
      enabled-extensions = [ "status-area-horizontal-spacing@mathematical.coffee.gmail.com" ];
    };

    "org/gnome/shell/extensions/status-area-horizontal-spacing" = {
      hpadding = 8;
    };
  };

  home.packages = with pkgs.gnomeExtensions; [ status-area-horizontal-spacing ];

}
