_:
let
  mkApp = import ../../../lib/mkApp.nix;
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
        taps = [
          {
            name = "oven-sh/bun";
            trusted = true;
          }
        ];
        brews = [
          {
            name = "oven-sh/bun/bun";
            trusted = true;
          }
        ];
      };
    };
}
