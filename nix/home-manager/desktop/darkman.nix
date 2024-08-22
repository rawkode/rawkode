{ lib, pkgs, ... }:
{
  services.darkman = {
    enable = true;

    darkModeScripts = {
      gtk-theme = ''
        ${lib.getExe pkgs.dconf} write /org/gnome/desktop/interface/color-scheme "'prefer-dark'"
      '';
    };

    lightModeScripts = {
      gtk-theme = ''
        ${lib.getExe pkgs.dconf} write /org/gnome/desktop/interface/color-scheme "'prefer-light'"
      '';
    };

    settings = {
      usegeoclue = false;
      lat = 55.8617;
      lng = 4.2583;
    };
  };
}
