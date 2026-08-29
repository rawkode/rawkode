_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "just";

  common.home =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [
        just
      ];
    };
}
