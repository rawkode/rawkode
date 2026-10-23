_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "misc";

  common.home =
    {
      config,
      inputs,
      lib,
      pkgs,
      system,
      isDarwin,
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

        programs.fzf = {
          enable = true;
          # Pair stable Nu with stable FZF on Darwin; Linux uses current Nushell
          # and FZF from the primary nixpkgs channel.
          package = if isDarwin then inputs.nixpkgs-stable.legacyPackages.${system}.fzf else pkgs.fzf;
          historyWidget.command = "";
        };
        programs.skim.enable = true;
      };
    };
}
