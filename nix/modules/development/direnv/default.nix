{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "direnv";

  common.home =
    { inputs, pkgs, ... }:
    {
      programs.direnv = {
        enable = true;
        package = inputs.nixpkgs-25-05.legacyPackages.${pkgs.stdenv.hostPlatform.system}.direnv;
        nix-direnv.enable = true;
      };
    };
}
