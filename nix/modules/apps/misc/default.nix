{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "misc";

  common.home =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [
        ffmpeg
        nodejs
        prettier
        tldr
        unzip
        vim
        watch
      ];

      programs.fzf.enable = true;
      programs.skim.enable = true;
    };
}
