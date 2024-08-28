{ pkgs, ... }:
{
  xdg.desktopEntries = {
    github = {
      name = "GitHub";
      icon = ./icon.svg;
      startupNotify = true;
      exec = ''${pkgs.vivaldi}/bin/vivaldi --app="https://github.com"'';
      settings = {
        Keywords = "gmail";
        StartupWMClass = "vivaldi-github.com__-Default";
      };
    };
  };
}
