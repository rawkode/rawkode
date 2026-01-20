{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "git-delta";

  common.home = {
    programs.delta = {
      enable = true;
      enableGitIntegration = true;

      options = {
        navigate = true;
        side-by-side = true;
        line-numbers = true;
      };
    };
  };
}
