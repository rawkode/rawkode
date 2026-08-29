_:
let
  mkApp = import ../../../lib/mkApp.nix;
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
        taps = [ "deskflow/tap" ];
        casks = [ "deskflow/tap/deskflow-dev" ];
      };
    };
}
