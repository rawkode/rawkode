{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "bat";

  common.home =
    { lib, pkgs, ... }:
    {
      programs.bat = {
        enable = true;

        config = {
          style = "auto,header-filesize";
        };

        extraPackages = with pkgs.bat-extras; [
          batdiff
          batgrep
          batman
          batpipe
          batwatch
          prettybat
        ];
      };

      home.shellAliases = {
        cat = "${lib.getExe pkgs.bat} --style=plain";
      };
    };
}
