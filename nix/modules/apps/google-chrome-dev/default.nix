{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "google-chrome-dev";

  # nixpkgs only packages the stable channel; browser-previews tracks dev.
  # Google publishes no Linux arm64 build, so aarch64 hosts go without.
  linux.home =
    { lib, pkgs, ... }:
    let
      chromePackages = inputs.browser-previews.packages.${pkgs.stdenv.hostPlatform.system} or { };
    in
    {
      home.packages = lib.optional (chromePackages ? google-chrome-dev) chromePackages.google-chrome-dev;
    };

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "google-chrome@dev" ];
      };
    };
}
