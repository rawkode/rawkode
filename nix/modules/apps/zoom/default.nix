{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "zoom";

  common.home =
    { lib, pkgs, ... }:
    {
      home.packages = lib.optionals (lib.meta.availableOn pkgs.stdenv.hostPlatform pkgs.zoom-us) [
        pkgs.zoom-us
      ];
    };
}
