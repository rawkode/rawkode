_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "doggo";

  common.home =
    { pkgs, ... }:
    {
      home.packages = [ pkgs.doggo ];
    };
}
