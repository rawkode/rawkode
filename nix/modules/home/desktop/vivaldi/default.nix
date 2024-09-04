{
  lib,
  osConfig,
  pkgs,
  ...
}:
with lib;
let
  # gnome = osConfig.rawkOS.desktop.gnome;
  plasma = osConfig.rawkOS.desktop.plasma;
in
{
  programs.vivaldi.enable = true;
  home.packages =
    [ ]
    ++ (
      with pkgs;
      optionals (plasma.enable) [
        kdePackages.plasma-browser-integration
        libsForQt5.qt5.qtwayland
      ]
    );

  home.file.".config/vivaldi/NativeMessagingHosts/org.kde.plasma.browser_integration.json".text = ''
    {
      "name": "org.kde.plasma.browser_integration",
      "description": "Native connector for KDE Plasma",
      "path": "${pkgs.kdePackages.plasma-browser-integration}/bin/plasma-browser-integration-host",
      "type": "stdio",
      "allowed_origins": [
        "chrome-extension://cimiefiiaegbelhefglklhhakcgmhkai/"
      ]
    }
  '';

  xdg.mimeApps.defaultApplications = {
    "text/html" = "vivaldi-stable.desktop";
    "x-scheme-handler/http" = "vivaldi-stable.desktop";
    "x-scheme-handler/https" = "vivaldi-stable.desktop";
    "x-scheme-handler/about" = "vivaldi-stable.desktop";
    "x-scheme-handler/unknown" = "vivaldi-stable.desktop";
  };
}
