{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "zoxide";

  common.home = _: {
    programs.zoxide = {
      enable = true;
      enableFishIntegration = true;
      enableNushellIntegration = false;
      options = [
        "--cmd cd"
      ];
    };
  };
}
