{
  lib,
  osConfig ? { },
  pkgs,
  ...
}:
let
  cfg = osConfig.rawkOS.desktop.hyprland or { enable = false; };
  wallpaper = builtins.fetchurl {
    url = "https://raw.githubusercontent.com/RawkodeAcademy/RawkodeAcademy/main/wallpapers/dark-rawkode-logo.svg";
    sha256 = "1l6778s6n24mnfx3idsyq1v7qzqaixpd458y390i1kx4a6lvany9";
  };
  wallpaperPng = pkgs.runCommand "wallpaper.png" { } ''
    ${pkgs.imagemagick}/bin/magick convert -size 3440x1440 ${wallpaper} $out
  '';
in
{
  config = lib.mkIf cfg.enable {
    services.hyprpaper = {
      enable = true;
      settings = {
        preload = "${builtins.toString wallpaperPng}";
        # , for all displays
        wallpaper = ",${builtins.toString wallpaperPng}";
      };
    };
  };
}
