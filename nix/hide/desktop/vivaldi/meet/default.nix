{ pkgs, ... }:
{
  xdg.desktopEntries = {
    meet = {
      name = "Meet";
      genericName = "Google Meet";
      icon = ./icon.svg;
      exec = ''${pkgs.vivaldi}/bin/vivaldi --app="https://meet.google.com"'';
      startupNotify = true;
      settings = {
        Keywords = "meet";
        StartupWMClass = "vivaldi-meet.google.com__-Default";
      };
    };
  };
}
