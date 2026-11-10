{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "noctalia";

  linux.home = _: {
    imports = [ inputs.noctalia.homeModules.default ];

    # No systemd unit: Umbriel autostarts the shell, so it never runs beside
    # Dux in a niri session. Stylix's noctalia target supplies the palette,
    # font and wallpaper.
    programs.noctalia = {
      enable = true;

      # Every gap, padding, margin and radius is a power of two, matching the
      # compositor's 16px layout gap.
      settings = {
        bar.default = {
          # Full width and docked; the 16px padding lines the widgets up with
          # the window edges below.
          margin_ends = 0;
          margin_edge = 0;
          thickness = 32;
          padding = 16;
          # Also the gap between tray icons, which has no setting of its own.
          widget_spacing = 16;
          capsule_padding = 8;
          radius = 16;
          background_opacity = 0.96;

          start = [ "workspaces" ];
          center = [ "clock" ];
          # Network, audio, notifications and session controls are reached
          # through the control center, which the clock opens.
          end = [ "tray" ];
        };

        widget.tray = {
          capsule_padding = 8;
          scale = 1.0;
        };

        shell.launcher = {
          compact = true;
          show_navigation_labels = false;
          show_session_button = false;
          show_settings_button = false;
          # Single-letter triggers, typed after the "/" provider prefix.
          providers = {
            emoji.prefix = "e";
            session.prefix = "s";
            windows.prefix = "w";
          };
        };

        control_center.width = 1080;
        dock.item_spacing = 8;
        notification.offset_x = 16;
        osd.offset_x = 16;
      };
    };
  };
}
