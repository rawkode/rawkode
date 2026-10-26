{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "openbot";

  common.home =
    { pkgs, ... }:
    {
      home.packages = [ inputs.openbot.packages.${pkgs.stdenv.hostPlatform.system}.default ];
    };
}
