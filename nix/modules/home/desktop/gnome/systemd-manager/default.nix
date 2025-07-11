{ lib, pkgs, ... }:
with lib;

{

  home.packages = with pkgs.gnomeExtensions; [ systemd-manager ];

  dconf.settings = {
    "org/gnome/shell" = {
      enabled-extensions = [ "systemd-manager@hardpixel.eu" ];
    };
  };

}
