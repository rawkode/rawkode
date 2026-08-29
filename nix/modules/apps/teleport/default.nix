_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "teleport";

  common.home =
    { pkgs, ... }:
    {
      home.packages = [ pkgs.teleport ];
    };
}
