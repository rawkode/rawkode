_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "google-chrome";

  linux.home =
    { lib, ... }:
    {
      xdg.mimeApps = {
        enable = true;
        defaultApplications = lib.genAttrs [
          "application/xhtml+xml"
          "text/html"
          "x-scheme-handler/about"
          "x-scheme-handler/http"
          "x-scheme-handler/https"
        ] (_: lib.mkForce [ "google-chrome.desktop" ]);
      };
    };

  linux.system =
    {
      lib,
      pkgs,
      ...
    }:
    let
      chromePackage = pkgs.google-chrome;
      chromeSupported = lib.meta.availableOn pkgs.stdenv.hostPlatform chromePackage;
    in
    {
      stylix.targets.chromium.enable = false;

      # Install only the stable Google Chrome package.
      environment.systemPackages = lib.optionals chromeSupported [ chromePackage ];
    };

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "google-chrome" ];
      };
    };
}
