{ inputs, pkgs, ... }:

{
  home.packages = (
    with pkgs;
    [
      kdePackages.plasma-browser-integration
      libsForQt5.qt5.qtwayland
    ]
  );

  xdg.configFile."vivaldi/NativeMessagingHosts/org.kde.plasma.browser_integration.json".source = "${pkgs.plasma-browser-integration}/etc/chromium/native-messaging-hosts/org.kde.plasma.browser_integration.json";

  xdg.mimeApps.defaultApplications = {
    "text/html" = "vivaldi-stable.desktop";
    "x-scheme-handler/http" = "vivaldi-stable.desktop";
    "x-scheme-handler/https" = "vivaldi-stable.desktop";
    "x-scheme-handler/about" = "vivaldi-stable.desktop";
    "x-scheme-handler/unknown" = "vivaldi-stable.desktop";
  };

  programs.firefox = {
    enable = true;
    package = inputs.firefox.packages.${pkgs.system}.firefox-nightly-bin;
  };

  programs.vivaldi.enable = true;
}
