{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "zoom";

  linux.home =
    { lib, pkgs, ... }:
    {
      home.packages = lib.optionals (lib.meta.availableOn pkgs.stdenv.hostPlatform pkgs.zoom-us) [
        pkgs.zoom-us
      ];
    };
}
