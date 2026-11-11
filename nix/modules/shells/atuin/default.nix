_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "atuin";

  common.home = _: {
    programs.atuin = {
      enable = true;

      enableFishIntegration = true;
      enableNushellIntegration = true;

      settings = {
        style = "compact";
        show_preview = true;
        enter_accept = true;
        search_mode = "daemon-fuzzy";
        output_capture = true;
        filter_mode = "directory";
        filter_mode_shell_up_key_binding = "session";
        inline_height = 0; # Do not clear screen when tab / enter
        ai = {
          enabled = true;
        };
        pty_proxy = {
          enabled = true;
        };
        output = {
          enabled = true;
        };
      };

      # Runs the daemon as a socket-activated systemd user service (launchd
      # agent on macOS) and sets `settings.daemon.enabled` to match, so the
      # client must not autostart its own copy.
      daemon.enable = true;
    };

  };
}
