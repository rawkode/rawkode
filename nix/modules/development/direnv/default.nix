{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "direnv";

  common.home = {
    programs.direnv = {
      enable = true;
      nix-direnv.enable = true;
    };
  };
}
