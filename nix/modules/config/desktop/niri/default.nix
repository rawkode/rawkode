{ inputs, ... }:
{
  flake.nixosModules.niri =
    { pkgs, ... }:
    {
      programs.niri.enable = true;
      systemd.user.services.niri-flake-polkit.enable = false;

      environment.systemPackages = with pkgs; [
        blueman
        brightnessctl
        hypridle
        hyprlock
        iwgtk
        pavucontrol
        polkit_gnome
        swaynotificationcenter
        swww
        wl-clipboard
      ];
    };

  flake.homeModules.niri =
    {
      lib,
      pkgs,
      ...
    }:
    let
      makeCommand = command: { command = [ command ]; };
    in
    {
      imports = with inputs; [
        niri.homeModules.stylix
        self.homeModules.darkman
        self.homeModules.hypridle
        self.homeModules.swaync
        self.homeModules.swww
      ];

      home.packages = with pkgs; [
        cosmic-files
        cosmic-panel
      ];

      xdg.portal = {
        extraPortals = with pkgs; [
          xdg-desktop-portal-gnome
        ];
        config = {
          niri = {
            default = [
              "gnome"
              "gtk"
            ];
            "org.freedesktop.impl.portal.FileChooser" = [
              "gtk"
            ];
            "org.freedesktop.impl.portal.Notification" = [
              "gtk"
            ];
            "org.freedesktop.impl.portal.Screenshot" = [
              "gnome"
            ];
            "org.freedesktop.impl.portal.ScreenCast" = [
              "gnome"
            ];
            "org.freedesktop.impl.portal.Secret" = [
              "gnome-keyring"
            ];
          };
        };
      };

      services.swayosd.enable = true;

      systemd.user.services = {
        # Override swayosd to only run in niri
        swayosd = {
          Unit = {
            ConditionEnvironment = lib.mkForce [
              "WAYLAND_DISPLAY" # Keep the original condition
              "XDG_CURRENT_DESKTOP=niri"
            ];
          };
        };
        polkit-gnome = {
          Unit = {
            Description = "PolicyKit Authentication Agent for niri";
            # Only start when running niri
            ConditionEnvironment = "XDG_CURRENT_DESKTOP=niri";
            After = [ "graphical-session.target" ];
            PartOf = [ "graphical-session.target" ];
          };
          Service = {
            Type = "simple";
            ExecStart = "${pkgs.polkit_gnome}/libexec/polkit-gnome-authentication-agent-1";
            Restart = "on-failure";
            RestartSec = 1;
            TimeoutStopSec = 10;
          };
          Install = {
            WantedBy = [ "graphical-session.target" ];
          };
        };

      };

      programs.niri = {
        enable = true;
        settings = {
          environment = {
            DISPLAY = ":0";
            QT_QPA_PLATFORM = "wayland";
            XDG_CURRENT_DESKTOP = "niri";
            XDG_SESSION_TYPE = "wayland";

            # Graphics performance optimizations
            GSK_RENDERER = "vulkan"; # Force Vulkan for maximum GTK performance

            # Fallback safety - if Vulkan fails, use optimized OpenGL
            GSK_DEBUG = "fallback"; # Enable renderer fallback mechanism
          };

          spawn-at-startup = [
            # Ensure portals are started early for optimal desktop integration
            {
              command = [
                "systemctl"
                "--user"
                "start"
                "xdg-desktop-portal.service"
                "xdg-desktop-portal-gtk.service"
              ];
            }
            (makeCommand "blueman-applet")
            (makeCommand "iwgtk-indicator")
          ];

          outputs = {
            # Laptop ...
            "eDP-1" = {
              scale = 2.0;
              position = {
                x = 0;
                y = 0;
              };
            };

            # Office Monitors
            "DP-1" = {
              scale = 2.0;
              position = {
                x = 0;
                # Logical size of Teleprompter is x540, due to 2xScale
                y = 540;
              };
              focus-at-startup = true;
            };

            "DP-2" = {
              scale = 2.0;
              position = {
                x = 1920;
                y = 540;
              };
            };

            # This is my Teleprompter monitor
            "Invalid Vendor Codename - RTK Field Monitor J257M96B00FL" = {
              scale = 2.0;
              mode = {
                width = 1920;
                height = 1080;
                refresh = 60.0;
              };
              transform.rotation = 0;
              position = {
                x = 0;
                y = 0;
              };
            };

            # Monitor for my laptop at home
            "Samsung Electric Company LS32A70 HK2WB00305" = {
              scale = 1.75;
            };
          };

          input = {
            keyboard = {
              numlock = true;
            };
            focus-follows-mouse = {
              enable = true;
              max-scroll-amount = "0%";
            };
            touchpad = {
              tap = true;
              natural-scroll = true;
              click-method = "clickfinger";
              dwt = true;
              disabled-on-external-mouse = true;
            };
            mouse = {
              natural-scroll = true;
            };
          };

          cursor = {
            hide-when-typing = true;
            hide-after-inactive-ms = 1000;
          };

          hotkey-overlay = {
            skip-at-startup = true;
          };

          prefer-no-csd = true;

          animations = {
            slowdown = 0.6;
          };

          overview = {
            zoom = 0.32;
          };

          layout = {
            gaps = 16;

            center-focused-column = "on-overflow";

            preset-column-widths = [
              { proportion = 0.5; }
              { proportion = 0.75; }
              { proportion = 1.0; }
            ];

            preset-window-heights = [
              { proportion = 0.5; }
              { proportion = 0.75; }
              { proportion = 1.0; }
            ];
          };

          switch-events = {
            lid-close = {
              action = {
                spawn = [
                  "systemctl"
                  "poweroff"
                ];
              };
            };
          };

          window-rules = [
            {
              matches = [
                { app-id = "vivaldi"; }
                { app-id = "vivaldi-stable"; }
                { app-id = "firefox"; }
              ];
              open-on-workspace = "Web";
              open-focused = true;
              open-maximized = true;
            }
            {
              matches = [
                {
                  app-id = "firefox$";
                  title = "^Picture-in-Picture$";
                }
              ];
              open-floating = true;
            }
            {
              matches = [
                { app-id = "com.slack.Slack"; }
                { app-id = "org.zulip.Zulip"; }
              ];
              open-on-workspace = "Chat";
              open-focused = true;
              open-maximized = true;
            }
            {
              matches = [ { app-id = "Zoom Workplace"; } ];
              excludes = [
                { title = "Zoom Meeting"; }
                { title = "Meeting"; }
              ];
              open-floating = true;
              open-focused = false;
            }
            {
              matches = [
                { app-id = "code"; }
                { app-id = "com.mitchellh.ghostty"; }
              ];
              open-on-workspace = "Code";
              open-focused = true;
              open-maximized = true;
            }
            {
              matches = [
                { is-floating = true; }
              ];
              geometry-corner-radius = {
                top-left = 16.0;
                top-right = 16.0;
                bottom-right = 16.0;
                bottom-left = 16.0;
              };
              clip-to-geometry = true;
            }
            {
              matches = [
                { is-window-cast-target = true; }
              ];
              shadow = {
                color = "#d75f5e40";
              };
            }
            {
              matches = [
                { app-id = "1Password"; }
                { title = "[Gg]mail"; }
                { app-id = ".*[Ss]waync.*"; }
              ];
              block-out-from = "screen-capture";
            }
            {
              matches = [
                { is-floating = false; }
              ];
              shadow = {
                enable = true;
                color = "#00000060";
                softness = 10;
                spread = 3;
                offset = {
                  x = 0;
                  y = 3;
                };
                draw-behind-window = true;
              };
            }
          ];

          binds = {
            "Super+Q" = {
              action.close-window = { };
            };
            "Super+Shift+Q" = {
              action.quit = { };
            };

            "Super+T" = {
              action.toggle-column-tabbed-display = { };
            };

            "Ctrl+Down" = {
              action.toggle-overview = { };
            };

            "Super+N" = {
              action = {
                spawn = [
                  "swaync-client"
                  "-t"
                ];
              };
            };

            "Super+Return" = {
              action = {
                spawn = [ "ghostty" ];
              };
            };

            "Super+Backslash" = {
              action = {
                spawn = [
                  "1password"
                  "--quick-access"
                ];
              };
            };
            "Super+Comma" = {
              action.consume-window-into-column = { };
            };

            "Super+Period" = {
              action.expel-window-from-column = { };
            };

            "Super+Page_Down" = {
              action.focus-monitor-next = { };
            };

            "Super+Page_Up" = {
              action.focus-monitor-previous = { };
            };

            "Super+Shift+Page_Down" = {
              action.move-column-to-monitor-next = { };
            };

            "Super+Shift+Page_Up" = {
              action.move-column-to-monitor-previous = { };
            };

            "Super+Up" = {
              action.focus-window-up = { };
            };

            "Super+Down" = {
              action.focus-window-down = { };
            };

            "Super+Left" = {
              action.focus-column-left = { };
            };

            "Super+Shift+Left" = {
              action.move-column-left = { };
            };

            "Super+Right" = {
              action.focus-column-right = { };
            };

            "Super+Shift+Right" = {
              action.move-column-right = { };
            };

            "Super+1" = {
              action.focus-workspace = 1;
            };
            "Super+2" = {
              action.focus-workspace = 2;
            };
            "Super+3" = {
              action.focus-workspace = 3;
            };
            "Super+4" = {
              action.focus-workspace = 4;
            };
            "Super+5" = {
              action.focus-workspace = 5;
            };
            "Super+6" = {
              action.focus-workspace = 6;
            };
            "Super+7" = {
              action.focus-workspace = 7;
            };
            "Super+8" = {
              action.focus-workspace = 8;
            };
            "Super+9" = {
              action.focus-workspace = 9;
            };
            "Super+Shift+1" = {
              action.move-column-to-workspace = 1;
            };
            "Super+Shift+2" = {
              action.move-column-to-workspace = 2;
            };
            "Super+Shift+3" = {
              action.move-column-to-workspace = 3;
            };
            "Super+Shift+4" = {
              action.move-column-to-workspace = 4;
            };
            "Super+Shift+5" = {
              action.move-column-to-workspace = 5;
            };
            "Super+Shift+6" = {
              action.move-column-to-workspace = 6;
            };
            "Super+Shift+7" = {
              action.move-column-to-workspace = 7;
            };
            "Super+Shift+8" = {
              action.move-column-to-workspace = 8;
            };
            "Super+Shift+9" = {
              action.move-column-to-workspace = 9;
            };
            "Super+F" = {
              action.fullscreen-window = { };
            };
            "Super+R" = {
              action.switch-preset-column-width = { };
            };
            "Super+Shift+R" = {
              action.switch-preset-window-height = { };
            };
            "Ctrl+Shift+Space" = {
              action.toggle-window-floating = { };
            };
            "Print" = {
              action.screenshot-window = { };
            };
            "Super+Print" = {
              action.screenshot = { };
            };
            "XF86MonBrightnessUp" = {
              allow-when-locked = true;
              action = {
                spawn-sh = "swayosd-client --brightness raise";
              };
            };
            "XF86MonBrightnessDown" = {
              allow-when-locked = true;
              action = {
                spawn-sh = "swayosd-client --brightness lower";
              };
            };
            "Super+L" = {
              action = {
                spawn = [ "hyprlock" ];
              };
              allow-when-locked = true;
            };
            "Super+Shift+L" = {
              action.power-off-monitors = { };
            };
            "XF86AudioLowerVolume" = {
              allow-when-locked = true;
              action = {
                spawn-sh = "swayosd-client --output-volume lower";
              };
            };
            "XF86AudioMute" = {
              allow-when-locked = true;
              action = {
                spawn-sh = "swayosd-client --output-volume mute-toggle";
              };
            };
            "XF86AudioRaiseVolume" = {
              allow-when-locked = true;
              action = {
                spawn-sh = "swayosd-client --output-volume raise";
              };
            };
            "XF86AudioNext" = {
              allow-when-locked = true;
              action = {
                spawn-sh = "swayosd-client --playerctl next";
              };
            };
            "XF86AudioPrev" = {
              allow-when-locked = true;
              action = {
                spawn-sh = "swayosd-client --playerctl prev";
              };
            };
            "XF86AudioPlay" = {
              allow-when-locked = true;
              action = {
                spawn-sh = "swayosd-client --playerctl play-pause";
              };
            };
          };
        };
      };

    };
}
