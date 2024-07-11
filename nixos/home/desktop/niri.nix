{
  inputs,
  config,
  lib,
  pkgs,
  ...
}:
{
  home.packages = with pkgs; [
    fuzzel
    xwayland
    xwayland-satellite
  ];

  programs.walker = {
    enable = true;
    runAsService = false;

    config = {
      placeholder = "Search ...";
      fullscreen = false;
      list = {
        height = 200;
      };
      modules = [
        {
          name = "applications";
          prefix = "";
        }
        {
          name = "runner";
          prefix = "$";
        }
        {
          name = "websearch";
          prefix = "?";
        }
        {
          name = "switcher";
          prefix = "/";
        }
        {
          name = "finder";
          prefix = "~";
        }
      ];
    };
  };

  programs.niri = {
    enable = true;

    settings = {
      outputs = {
        eDP-1 = {
          scale = 1.5;
        };

        DP-1 = {
          scale = 1.5;
        };

        DP-2 = {
          scale = 1.5;
        };
      };

      input.mouse = {
        natural-scroll = true;
      };

      window-rules = [
        {
          matches = [ { app-id = "^org.wezfurlong.wezterm$"; } ];
          default-column-width = { };
        }
      ];

      environment = {
        DISPLAY = ":25";
      };

      spawn-at-startup = [
        {
          command = [
            "${pkgs.xwayland-satellite}/bin/xwayland-satellite"
            ":25"
          ];
        }
        {
          command = [
            "${pkgs.dbus}/bin/dbus-update-activation-environment"
            "--systemd"
            "DISPLAY"
            "WAYLAND_DISPLAY"
            "SWAYSOCK"
            "XDG_CURRENT_DESKTOP"
            "XDG_SESSION_TYPE"
            "NIXOS_OZONE_WL"
            "XCURSOR_THEME"
            "XCURSOR_SIZE"
            "XDG_DATA_DIRS"
          ];
        }
        { command = [ "/usr/libexec/polkit-gnome-authentication-agent-1" ]; }
        { command = [ (lib.getExe' config.services.mako.package "mako") ]; }
      ];

      layout = {
        gaps = 16;
        center-focused-column = "always";
        preset-column-widths = [
          { proportion = 0.25; }
          { proportion = 0.5; }
          { proportion = 0.75; }
        ];

        default-column-width = {
          proportion = 0.5;
        };

        focus-ring = {
          enable = true;
          width = 2;
        };
      };

      animations =
        let
          butter = {
            spring = {
              damping-ratio = 0.75;
              epsilon = 1.0e-4;
              stiffness = 400;
            };
          };
          smooth = {
            spring = {
              damping-ratio = 0.58;
              epsilon = 1.0e-4;
              stiffness = 735;
            };
          };
        in
        {
          slowdown = 1.3;
          horizontal-view-movement = butter;
          window-movement = butter;
          workspace-switch = butter;
          window-open = smooth;
          window-close = smooth;
        };

      binds =
        with config.lib.niri.actions;
        let
          sh = spawn "sh" "-c";
        in
        {
          # Hotkey Overlay
          "Mod+Shift+Slash".action = show-hotkey-overlay;

          # Launcher
          "Super+Space".action = spawn "${pkgs.fuzzel}/bin/fuzzel";

          # Windows
          "Super+W".action = spawn "${inputs.ghostty.packages.x86_64-linux.default}/bin/ghostty";
          "Super+Q".action = close-window;

          # Quit Niri
          "Super+Shift+Q".action = quit;

          # # Lock Session
          # "Super+L".action = spawn "${pkgs.systemd}/bin/loginctl" "lock-session";

          # Screenshotting
          "Print".action = screenshot;

          # Windows
          "Mod+Left".action = focus-column-left;
          "Mod+Right".action = focus-column-right;
          "Mod+Down".action = focus-window-down;
          "Mod+Up".action = focus-window-up;
          "Mod+F".action = maximize-column;

          "Mod+Page_Down".action = focus-monitor-down;
          "Mod+Page_Up".action = focus-monitor-up;

          # Workspaces
          "Super+0".action = focus-workspace 0;
          "Super+1".action = focus-workspace 1;
          "Super+2".action = focus-workspace 2;
          "Super+3".action = focus-workspace 3;
          "Super+4".action = focus-workspace 4;
          "Super+5".action = focus-workspace 5;
          "Super+6".action = focus-workspace 6;
          "Super+7".action = focus-workspace 7;
          "Super+8".action = focus-workspace 8;
          "Super+9".action = focus-workspace 9;

          # Special Keys
          "XF86AudioRaiseVolume".action = sh "wpctl" "set-volume" "@DEFAULT_AUDIO_SINK@" "0.1+";
          "XF86AudioLowerVolume".action = sh "wpctl" "set-volume" "@DEFAULT_AUDIO_SINK@" "0.1-";
          "XF86AudioMute".action = sh "wpctl" "set-mute" "@DEFAULT_AUDIO_SINK@" "toggle";
        };
    };
  };
}
