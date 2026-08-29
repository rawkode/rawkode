_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "mimestream";

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "mimestream" ];
      };
    };
}
