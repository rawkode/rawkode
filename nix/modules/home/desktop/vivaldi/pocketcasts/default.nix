{ pkgs, ... }:
{
  xdg.desktopEntries = {
    pocketcasts = {
      name = "PocketCasts";
      icon = ./icon.svg;
      exec = ''${pkgs.vivaldi}/bin/vivaldi --app="https://play.pocketcasts.com/podcasts" %U'';
      startupNotify = true;
      settings = {
        Keywords = "meet";
        StartupWMClass = "vivaldi-play.pocketcasts.com__podcasts__-Default";
      };
    };
  };
}
