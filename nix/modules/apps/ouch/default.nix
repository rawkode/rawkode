{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "ouch";

  common.home =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [
        ouch
      ];
    };
}
