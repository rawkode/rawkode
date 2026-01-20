{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "tana";

  linux.home =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [ tana ];
    };
}
