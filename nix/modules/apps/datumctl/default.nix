_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "datumctl";

  common.home =
    { inputs, pkgs, ... }:
    {
      home.packages = [
        inputs.datumctl.packages.${pkgs.stdenv.hostPlatform.system}.default
      ];
    };

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "datum-cloud/tap/desktop" ];
      };
    };
}
