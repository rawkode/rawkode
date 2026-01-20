{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "lazyjournal";

  common.home =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [
        lazyjournal
      ];
    };
}
