_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "cue";

  common.home =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [
        cue
      ];
    };
}
