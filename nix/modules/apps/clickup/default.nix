{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "clickup";

  linux.home =
    { lib, pkgs, ... }:
    {
      home.packages = lib.optionals pkgs.stdenv.isx86_64 (
        with pkgs;
        [
          clickup
        ]
      );
    };
}
