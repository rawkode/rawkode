{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "deno";

  common.home =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [ deno ];
      home.sessionPath = [ "$HOME/.deno/bin" ];
    };
}
