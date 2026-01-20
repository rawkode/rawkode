{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "cue";

  common.home =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [
        cue
      ];
    };
}
