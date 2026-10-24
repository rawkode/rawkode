{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "chinstrap";

  linux.home =
    { pkgs, ... }:
    {
      home.packages = [ inputs.chinstrap.packages.${pkgs.stdenv.hostPlatform.system}.default ];
    };
}
