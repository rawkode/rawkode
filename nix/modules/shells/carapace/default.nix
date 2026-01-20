{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "carapace";

  common.home = _: {
    programs.carapace = {
      enable = true;

      enableFishIntegration = true;
      enableNushellIntegration = true;
    };
  };
}
