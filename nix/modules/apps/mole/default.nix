_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "mole";

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        brews = [ "mole" ];
      };
    };
}
