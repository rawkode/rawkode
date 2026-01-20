{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "nh";

  common.home =
    { pkgs, ... }:
    {
      home.packages = [ pkgs.nh ];
    };
}
