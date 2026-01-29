{ inputs, lib, ... }:
let
  mkApp = import ../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "coreweave";

  common.home =
    {
      inputs,
      pkgs,
      ...
    }:
    {
      home.packages = with inputs.coreweave.packages.${pkgs.stdenv.hostPlatform.system}; [
        cw-eng-cli
        cwctl
        cwic
      ];
    };
}
