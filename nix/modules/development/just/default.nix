{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "just";

  common.home =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [
        just
      ];
    };
}
