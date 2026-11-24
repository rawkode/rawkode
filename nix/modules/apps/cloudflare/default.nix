_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "cloudflare";

  common.home =
    { pkgs, ... }:
    {
      home.packages = [ pkgs.cf ];
    };
}
