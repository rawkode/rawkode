{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "jj";

  common.home =
    {
      identity,
      pkgs,
      preferences,
      ...
    }:
    {
      home.packages = [ pkgs.gitsign ];

      programs.jujutsu = {
        enable = true;
        settings = {
          git = {
            sign-on-push = true;
          };
          signing = {
            backend = "gpgsm";
            behavior = "drop";
            backends.gpgsm.program = lib.getExe pkgs.gitsign;
          };
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
