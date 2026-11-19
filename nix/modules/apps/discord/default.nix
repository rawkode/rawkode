_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "discord";

  linux.home =
    { pkgs, ... }:
    {
      home.packages = [ pkgs.vesktop ];
    };

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "discord" ];
      };
    };
}
