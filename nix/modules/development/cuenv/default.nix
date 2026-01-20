{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "cuenv";

  common.home =
    {
      inputs,
      pkgs,
      ...
    }:
    {
      home.packages = [ inputs.cuenv.packages.${pkgs.stdenv.hostPlatform.system}.default ];
      programs.fish.interactiveShellInit = "cuenv shell init fish | source";
    };
}
