{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "dconf-editor";

  linux.home =
    { pkgs, ... }:
    {
      home.packages = [ pkgs.dconf-editor ];
    };
}
