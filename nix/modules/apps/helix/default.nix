_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "helix";

  common.home =
    { pkgs, ... }:
    {
      home.packages = [ pkgs.helix ];
    };
}
