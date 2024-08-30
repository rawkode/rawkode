{ pkgs, ... }:
{
  programs.vivaldi.enable = true;
  home.packages = (
    with pkgs;
    [
      kdePackages.plasma-browser-integration
      libsForQt5.qt5.qtwayland
    ]
  );

  xdg.mimeApps.defaultApplications = {
    "text/html" = "vivaldi-stable.desktop";
    "x-scheme-handler/http" = "vivaldi-stable.desktop";
    "x-scheme-handler/https" = "vivaldi-stable.desktop";
    "x-scheme-handler/about" = "vivaldi-stable.desktop";
    "x-scheme-handler/unknown" = "vivaldi-stable.desktop";
  };
}
