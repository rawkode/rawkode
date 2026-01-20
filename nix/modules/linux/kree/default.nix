{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "kree";

  darwin.system =
    { inputs, pkgs, ... }:
    {
      environment.systemPackages = [
        inputs.kree.packages.${pkgs.stdenv.hostPlatform.system}.default
      ];
    };
}
