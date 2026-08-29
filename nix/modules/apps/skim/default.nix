_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "skim";

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "skim" ];
      };
    };
}
