{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "misc";

  common.home =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.rawkOS.apps.misc;
    in
    {
      options.rawkOS.apps.misc.ffmpeg.enable =
        lib.mkEnableOption "ffmpeg in the common user package set"
        // {
          default = true;
        };

      config = {
        home.packages =
          lib.optionals cfg.ffmpeg.enable [ pkgs.ffmpeg ]
          ++ (with pkgs; [
            prettier
            tldr
            unzip
            vim
            watch
          ]);

        programs.fzf.enable = true;
        programs.skim.enable = true;
      };
    };
}
