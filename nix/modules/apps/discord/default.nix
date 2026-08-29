_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "discord";

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "discord" ];
      };
    };
}
