{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "jj";

  common.home =
    { identity, preferences, ... }:
    {
      programs.jujutsu = {
        enable = true;
        settings = {
          user = {
            inherit (identity) name;
            inherit (identity) email;
          };
          ui = {
            default-command = [
              "log"
              "--reversed"
              "--no-pager"
            ];
            inherit (preferences) editor;
          };
        };
      };
    };
}
