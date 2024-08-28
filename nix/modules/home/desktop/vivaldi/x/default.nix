{ pkgs, ... }:
{
  xdg.desktopEntries = {
    x = {
      name = "X";
      genericName = "Twitter";
      icon = ./icon.svg;
      startupNotify = true;
      exec = ''${pkgs.vivaldi}/bin/vivaldi --app="https://x.com"'';
      settings = {
        Keywords = "Twitter";
        StartupWMClass = "vivaldi-x.com__-Default";
      };
    };
  };

  dconf.settings = {
    "org/gnome/shell/extensions/auto-move-windows" = {
      application-list = [ "x.desktop:3" ];
    };
  };
}
