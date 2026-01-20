{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "comma";

  common.home =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [ comma ];
    };
}
