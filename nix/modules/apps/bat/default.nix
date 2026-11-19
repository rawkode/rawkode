_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "bat";

  common.home =
    {
      inputs,
      isDarwin,
      lib,
      pkgs,
      ...
    }:
    let
      # On aarch64-darwin, bat-extras pulls nushell as a build input and
      # unstable nushell lacks a binary cache; Linux stays on primary nixpkgs.
      batExtras =
        if isDarwin then
          inputs.nixpkgs-stable.legacyPackages.${pkgs.stdenv.hostPlatform.system}.bat-extras
        else
          pkgs.bat-extras;
    in
    {
      programs.bat = {
        enable = true;

        config = {
          style = "auto,header-filesize";
        };

        extraPackages = with batExtras; [
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
