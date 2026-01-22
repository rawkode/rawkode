{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "bun";

  common.home =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [ bun ];
      home.sessionPath = [
        "$HOME/.bun/bin"
      ];
    };
}
