{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "atuin";

  common.home =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    {
      programs.atuin = {
        enable = true;

        enableFishIntegration = true;
        enableNushellIntegration = true;

        settings = {
          style = "compact";
          show_preview = true;
          enter_accept = true;
          search_mode = "skim";
          filter_mode = "directory";
          filter_mode_shell_up_key_binding = "session";
          inline_height = 0; # Do not clear screen when tab / enter
          ai = {
            enabled = true;
          };
        };
      };

      programs.fish.interactiveShellInit = lib.mkIf config.programs.fish.enable ''
        ${lib.getExe pkgs.atuin} ai init fish | source
      '';
    };
}
