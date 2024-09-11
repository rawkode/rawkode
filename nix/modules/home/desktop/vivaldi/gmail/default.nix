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
}
