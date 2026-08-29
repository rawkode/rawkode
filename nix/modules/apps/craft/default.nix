_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "craft";

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "craft" ];
      };
    };
}
