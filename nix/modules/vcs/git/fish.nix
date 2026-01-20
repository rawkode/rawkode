{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "git-fish";

  common.home = {
    programs.fish = {
      shellAbbrs = {
        gr = {
          expansion = "cd (git root)";
          position = "command";
        };
      };
    };
  };
}
