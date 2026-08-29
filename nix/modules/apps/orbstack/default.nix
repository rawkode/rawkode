_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "orbstack";

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "orbstack" ];
      };
    };
}
