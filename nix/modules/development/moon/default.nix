{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "moon";

  common.home =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [ moon ];
    };
}
