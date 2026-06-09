{ inputs, lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "hunk";

  common.home =
    {
      config,
      pkgs,
      ...
    }:
    {
      imports = [ inputs.hunk.homeManagerModules.default ];

      programs.hunk = {
        enable = true;
        package = inputs.hunk.packages.${pkgs.stdenv.hostPlatform.system}.hunk;
        enableGitIntegration = false;
        settings = {
          theme = "graphite";
          mode = "auto";
          line_numbers = true;
        };
      };

      programs.jujutsu.settings.ui = lib.mkIf config.programs.jujutsu.enable {
        pager = [
          "hunk"
          "pager"
        ];
        diff-formatter = ":git";
      };
    };
}
