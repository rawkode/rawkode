{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "btop";

  common.home = {
    programs.btop = {
      enable = true;
    };
  };
}
