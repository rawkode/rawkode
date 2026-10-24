{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "antarctical";

  linux.home =
    { pkgs, ... }:
    {
      home.packages = [ inputs.antarctical.packages.${pkgs.stdenv.hostPlatform.system}.default ];
    };
}
