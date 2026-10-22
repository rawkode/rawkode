{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "sonora";

  linux.home =
    { pkgs, ... }:
    {
      home.packages = [ inputs.sonora.packages.${pkgs.stdenv.hostPlatform.system}.sonora-bin ];
    };
}
