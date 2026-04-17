{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "deskflow";

  linux.home =
    { pkgs, ... }:
    {
      home.packages = [ pkgs.deskflow ];
    };

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "deskflow" ];
      };
    };
}
