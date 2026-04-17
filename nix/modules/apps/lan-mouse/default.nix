{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "lan-mouse";

  common.home =
    {
      inputs,
      pkgs,
      ...
    }:
    {
      imports = [ inputs.lan-mouse.homeManagerModules.default ];

      programs.lan-mouse = {
        enable = true;
        package = inputs.lan-mouse.packages.${pkgs.stdenv.hostPlatform.system}.default;
      };
    };
}
