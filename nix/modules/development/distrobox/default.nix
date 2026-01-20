{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "distrobox";

  linux.home =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [
        boxbuddy
        distrobox
        toolbox
      ];
    };
}
