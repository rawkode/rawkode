{ pkgs, ... }:
{
  xdg.desktopEntries = {
    gmail = {
      name = "GMail";
      genericName = "Google Mail";
      icon = ./icon.svg;
      exec = ''${pkgs.vivaldi}/bin/vivaldi --app="https://mail.google.com"'';
      startupNotify = true;
      settings = {
        Keywords = "gmail";
        StartupWMClass = "vivaldi-mail.google.com__-Default";
      };
    };
  };

  dconf.settings = {
    "org/gnome/shell/extensions/auto-move-windows" = {
      application-list = [ "gmail.desktop:4" ];
    };
  };
}
