_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "steam";

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "steam" ];
      };
    };
}
