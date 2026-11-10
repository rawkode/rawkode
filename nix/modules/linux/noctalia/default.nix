{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "noctalia";

  linux.home =
    { pkgs, ... }:
    {
      imports = [ inputs.noctalia.homeModules.default ];

      # Lets the Phone Connect plugin mount and browse the phone's files.
      home.packages = [ pkgs.sshfs ];

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

            start = [
              "workspaces"
              "umbriel_layout"
            ];
            center = [ "active_window" ];
            # Everything else, including session controls, is reached through
            # the control center, which a right click on the clock opens.
            end = [
              "phone"
              "clipboard"
              "tray"
              "volume"
              "network"
              "notifications"
              "clock"
            ];
          };

          # Plugins are fetched from Noctalia's official and community git
          # sources at runtime; only the enabled list is declared here.
          plugins.enabled = [
            # Needs KDE Connect itself, which desktop-common installs.
            "icefish/phone-connect"
            "noctalia/umbriel-companion"
          ];

          widget = {
            # A named instance, because a raw plugin widget id in a bar list
            # cannot carry settings.
            phone.type = "icefish/phone-connect:bar";
            active_window = {
              display = "icon_only";
              icon_size = 24;
            };
            # Shows the focused workspace's layout; a click opens the layout
            # panel and a scroll cycles layouts.
            umbriel_layout.type = "noctalia/umbriel-companion:bar";
            tray = {
              capsule_padding = 8;
              scale = 1.0;
            };
            # Left click keeps the default calendar panel.
            clock.actions.right = "panel-toggle control-center";
            # Icon only; the SSID and volume level show in the control center.
            network.show_label = false;
            volume.show_label = false;
          };

          # The control center opens under the clock at the bar's right end.
          shell.panel = {
            control_center_position = "top_right";
            open_near_click_control_center = true;
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
