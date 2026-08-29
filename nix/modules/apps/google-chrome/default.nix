_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "google-chrome";

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
