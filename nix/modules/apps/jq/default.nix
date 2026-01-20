{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "jq";

  common.home =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [
        jq
      ];
    };
}
