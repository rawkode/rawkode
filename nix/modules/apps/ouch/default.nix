_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "ouch";

  common.home =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [
        ouch
      ];
    };
}
