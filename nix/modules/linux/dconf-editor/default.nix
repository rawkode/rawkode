_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "dconf-editor";

  linux.home =
    { pkgs, ... }:
    {
      home.packages = [ pkgs.dconf-editor ];
    };
}
