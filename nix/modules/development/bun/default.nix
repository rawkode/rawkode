{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "bun";

  linux.home =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [ bun ];
    };

  common.home = {
    home.sessionPath = [
      "$HOME/.bun/bin"
    ];
  };

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        brews = [ "bun" ];
      };
    };
}
