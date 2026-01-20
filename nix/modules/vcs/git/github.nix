{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "github";

  common.home =
    { pkgs, ... }:
    {
      programs.gh = {
        enable = true;

        extensions = with pkgs; [
          gh-copilot
        ];

        settings = {
          git_protocol = "ssh";
          prompt = "enabled";
        };
      };
    };
}
