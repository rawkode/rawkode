{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "pulumi";

  common.home =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [ pulumi-bin ];
    };
}
