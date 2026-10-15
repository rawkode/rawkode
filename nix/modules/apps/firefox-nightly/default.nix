_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "firefox-nightly";

  linux.home = {
    xdg.mimeApps = {
      enable = true;
      defaultApplications = {
        "text/html" = [ "firefox-nightly.desktop" ];
        "x-scheme-handler/http" = [ "firefox-nightly.desktop" ];
        "x-scheme-handler/https" = [ "firefox-nightly.desktop" ];
        "x-scheme-handler/about" = [ "firefox-nightly.desktop" ];
      };
    };
  };

  linux.system =
    { inputs, pkgs, ... }:
    {
      environment.systemPackages = [
        inputs.firefox-nightly.packages.${pkgs.stdenv.hostPlatform.system}.firefox-nightly-bin
      ];
    };

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "firefox@nightly" ];
      };
    };
}
