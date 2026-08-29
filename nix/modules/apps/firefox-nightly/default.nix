_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "firefox-nightly";

  linux.system =
    { inputs, pkgs, ... }:
    {
      environment.systemPackages = [
        inputs.firefox-nightly.packages.${pkgs.stdenv.hostPlatform.system}.firefox-nightly-bin
      ];
    };

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "firefox@nightly" ];
      };
    };
}
