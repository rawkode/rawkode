_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "infisical";

  common.home =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [
        infisical
      ];
    };
}
