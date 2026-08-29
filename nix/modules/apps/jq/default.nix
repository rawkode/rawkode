_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "jq";

  common.home =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [
        jq
      ];
    };
}
