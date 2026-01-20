{ inputs, lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
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
      inherit (pkgs.stdenv.hostPlatform) system;
      chromePackage = pkgs.google-chrome;
      chromeSupported = lib.meta.availableOn pkgs.stdenv.hostPlatform chromePackage;
      hasBrowserPreview = lib.attrsets.hasAttrByPath [
        system
        "google-chrome-dev"
      ] inputs.browser-previews.packages;
    in
    {
      stylix.targets.chromium.enable = false;

      # Install Google Chrome via nixpkgs
      # and Google Chrome (Dev) via browser-previews
      environment.systemPackages =
        lib.optionals chromeSupported [
          chromePackage
        ]
        ++ lib.optional hasBrowserPreview inputs.browser-previews.packages.${system}.google-chrome-dev;
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
