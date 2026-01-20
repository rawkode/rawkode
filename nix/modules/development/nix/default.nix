{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "nix-dev";

  common.home =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [
        nil
        nixfmt
      ];
    };
}
