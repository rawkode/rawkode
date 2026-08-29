_:
let
  mkApp = import ../../../lib/mkApp.nix;
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
