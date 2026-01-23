{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "github";

  common.home =
    { ... }:
    {
      programs.gh = {
        enable = true;

        settings = {
          git_protocol = "ssh";
          prompt = "enabled";
        };
      };
    };

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        brews = [
          "copilot-cli@prerelease"
        ];
      };
    };
}
