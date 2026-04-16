{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "bat";

  common.home =
    { lib, pkgs, inputs, system, ... }:
    let
      stable = inputs.nixpkgs-stable.legacyPackages.${system};
    in
    {
      programs.bat = {
        enable = true;

        config = {
          style = "auto,header-filesize";
        };

        # Use stable nixpkgs — bat-extras uses nushell as a build input,
        # and unstable nushell has no binary cache on aarch64-darwin
        extraPackages = with stable.bat-extras; [
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
