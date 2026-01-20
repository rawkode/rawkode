{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "dagger";

  common.home =
    {
      inputs,
      pkgs,
      ...
    }:
    {
      home.packages = [ inputs.dagger.packages.${pkgs.stdenv.hostPlatform.system}.dagger ];
    };
}
