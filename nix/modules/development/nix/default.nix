_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "nix-dev";

  common.home =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [
        nixd
        nixfmt
      ];
    };
}
