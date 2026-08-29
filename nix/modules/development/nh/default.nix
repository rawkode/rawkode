_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "nh";

  common.home =
    { pkgs, ... }:
    {
      home.packages = [ pkgs.nh ];
    };
}
