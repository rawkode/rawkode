_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "teleport";

  linux.home =
    { pkgs, ... }:
    {
      home.packages = [ pkgs.teleport ];
    };

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        brews = [ "teleport" ];
      };
    };
}
