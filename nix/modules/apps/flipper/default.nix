{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "flipper";

  linux.home =
    { pkgs, ... }:
    {
      home.packages = [ inputs.flipper.packages.${pkgs.stdenv.hostPlatform.system}.default ];
    };
}
