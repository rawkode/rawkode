_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "github-copilot-app";

  linux.home = { pkgs, ... }: {
    home.packages = [ pkgs.github-copilot-app ];
  };

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "github-copilot-app" ];
      };
    };
}
