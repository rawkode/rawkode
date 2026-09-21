_:
let
  mkApp = import ../../../lib/mkApp.nix;
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
          search_mode = "daemon-fuzzy";
          filter_mode = "directory";
          filter_mode_shell_up_key_binding = "session";
          inline_height = 0; # Do not clear screen when tab / enter
          ai = {
            enabled = true;
          };
          daemon = {
            enabled = true;
            autostart = true;
          };
        };
      };

      programs.fish.interactiveShellInit = lib.mkIf config.programs.fish.enable ''
        ${lib.getExe pkgs.atuin} ai init fish | source
      '';
    };
}
