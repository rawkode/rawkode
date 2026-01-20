{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "spotify";

  common.home =
    { lib, pkgs, ... }:
    {
      home.packages = lib.optionals (lib.meta.availableOn pkgs.stdenv.hostPlatform pkgs.spotify) [
        pkgs.spotify
      ];
    };
}
