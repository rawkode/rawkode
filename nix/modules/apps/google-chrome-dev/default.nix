{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "google-chrome-dev";

  # nixpkgs only packages the stable channel; browser-previews tracks dev.
  linux.home =
    { pkgs, ... }:
    {
      home.packages = [
        inputs.browser-previews.packages.${pkgs.stdenv.hostPlatform.system}.google-chrome-dev
      ];
    };

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "google-chrome@dev" ];
      };
    };
}
