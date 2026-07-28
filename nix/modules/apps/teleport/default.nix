{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "teleport";

  common.home =
    { pkgs, ... }:
    {
      home.packages = [ pkgs.teleport ];
    };
}
