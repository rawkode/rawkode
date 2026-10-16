{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;

  niriCache = {
    extra-substituters = [ "https://niri.cachix.org" ];
    extra-trusted-public-keys = [
      "niri.cachix.org-1:Wv0OmO7PsuocRKzfDoJ3mulSl7Z6oezYhGhR+3W2964="
    ];
  };
in
mkApp {
  name = "niri";

  linux.system =
    { pkgs, ... }:
    {
      imports = [
        inputs.niri.nixosModules.niri
      ];

      nix.settings = niriCache;

      programs.niri.enable = true;
      # niri-flake's own package build asserts a libdisplay-info version that
      # nixpkgs removed (2026-08-04); use nixpkgs' niri until upstream catches up.
      programs.niri.package = pkgs.niri;
      systemd.user.services.niri-flake-polkit.enable = false;

      # xremap runs as the desktop user and needs keyboard/uinput access.
      hardware.uinput.enable = true;
      users.users.rawkode.extraGroups = [
        "input"
        "uinput"
      ];

      environment.systemPackages = with pkgs; [
        blueman
        brightnessctl
        hypridle
        hyprlock
        iwgtk
        pavucontrol
        polkit_gnome
        swww
        wl-clipboard
      ];
    };

  linux.home =
    {
      lib,
      pkgs,
      osClass ? null,
      options,
      ...
    }:
    let
      makeCommand = command: { command = [ command ]; };
      xremap = pkgs.xremap.override { withVariant = "niri"; };
      niriEnableSupported =
        options ? programs && options.programs ? niri && options.programs.niri ? enable;
    in
    {
      nix.settings = niriCache;

      imports =
        lib.optionals (osClass != "nixos") [
          inputs.niri.homeModules.niri
          inputs.niri.homeModules.stylix
        ]
        ++ [
          inputs.self.homeModules.darkman
          inputs.self.homeModules.hypridle
          inputs.self.homeModules.swww
        ];

      home.packages = with pkgs; [
        cosmic-files
        cosmic-panel
        xremap
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

      xdg.configFile."xremap/config.json".source = ./macos-keymap.json;

      systemd.user.services = {
        xremap = {
          Unit = {
            Description = "macOS keyboard shortcuts for Niri";
            # The process reads the keymap once; restart after keymap updates.
            X-Restart-Triggers = [ "${./macos-keymap.json}" ];
            ConditionEnvironment = [
              "XDG_CURRENT_DESKTOP=niri"
              "NIRI_SOCKET"
            ];
            After = [ "graphical-session.target" ];
            PartOf = [ "graphical-session.target" ];
          };
          Service = {
            ExecStart = "${lib.getExe xremap} --watch=device --no-window-logging %h/.config/xremap/config.json";
            Restart = "on-failure";
            RestartSec = 2;
          };
          Install.WantedBy = [ "graphical-session.target" ];
        };
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

      programs.niri =
        lib.optionalAttrs niriEnableSupported {
          enable = true;
          # niri-flake's own package build asserts a libdisplay-info version that
          # nixpkgs removed (2026-08-04); use nixpkgs' niri until upstream catches up.
          package = pkgs.niri;
        }
        // {
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
              mod-key = "Super";
              mod-key-nested = "Super";
              keyboard = {
                numlock = true;
              };
              focus-follows-mouse = {
                enable = false;
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

            # Command+Left/Right focuses columns; add Shift for text selection.
            # Command+Up/Down remains available for document navigation.
            # Niri's H/J/K/L bindings remain; xremap handles Firefox's Cmd+L.
            # Native recent-windows defaults provide Command+Tab and grave.
            binds = {
              "Super+Shift+Slash".action.show-hotkey-overlay = { };
              "Super+Q".action.close-window = { };
              "Alt+F4".action.close-window = { };
              "Super+Left".action.focus-column-left = { };
              "Super+Right".action.focus-column-right = { };
              "Super+H".action.focus-column-left = { };
              "Super+J".action.focus-window-down = { };
              "Super+K".action.focus-window-up = { };
              "Super+L".action.focus-column-right = { };
              "Super+Ctrl+H".action.move-column-left = { };
              "Super+Ctrl+J".action.move-window-down = { };
              "Super+Ctrl+K".action.move-window-up = { };
              "Super+Ctrl+L".action.move-column-right = { };
              "Super+Alt+Left".action.focus-column-left = { };
              "Super+Alt+Down".action.focus-window-down = { };
              "Super+Alt+Up".action.focus-window-up = { };
              "Super+Alt+Right".action.focus-column-right = { };
              "Super+Ctrl+Left".action.move-column-left = { };
              "Super+Ctrl+Down".action.move-window-down = { };
              "Super+Ctrl+Up".action.move-window-up = { };
              "Super+Ctrl+Right".action.move-column-right = { };
              "Super+Shift+H".action.focus-monitor-left = { };
              "Super+Shift+J".action.focus-monitor-down = { };
              "Super+Shift+K".action.focus-monitor-up = { };
              "Super+Shift+L".action.focus-monitor-right = { };
              "Super+Home".action.focus-column-first = { };
              "Super+End".action.focus-column-last = { };
              "Super+Page_Up".action.focus-workspace-up = { };
              "Super+Page_Down".action.focus-workspace-down = { };
              "Super+I".action.focus-workspace-up = { };
              "Super+U".action.focus-workspace-down = { };
              "Super+Ctrl+Page_Up".action.move-column-to-workspace-up = { };
              "Super+Ctrl+Page_Down".action.move-column-to-workspace-down = { };
              "Super+Ctrl+I".action.move-column-to-workspace-up = { };
              "Super+Ctrl+U".action.move-column-to-workspace-down = { };
              "Super+Shift+Page_Up".action.move-workspace-up = { };
              "Super+Shift+Page_Down".action.move-workspace-down = { };
              "Super+O".action.toggle-overview = { };
              "Super+Comma".action.consume-window-into-column = { };
              "Super+Period".action.expel-window-from-column = { };
              "Super+R".action.switch-preset-column-width = { };
              "Super+Shift+R".action.switch-preset-column-width-back = { };
              "Super+Ctrl+Shift+R".action.switch-preset-window-height = { };
              "Super+Ctrl+R".action.reset-window-height = { };
              "Super+F".action.maximize-column = { };
              "Super+Shift+F".action.fullscreen-window = { };
              "Super+Ctrl+C".action.center-column = { };
              "Super+Shift+V".action.toggle-window-floating = { };
              "Super+Ctrl+Space".action.switch-focus-between-floating-and-tiling = { };
              "Super+Shift+T".action.toggle-column-tabbed-display = { };
              "Super+1".action.focus-workspace = 1;
              "Super+Ctrl+1".action.move-column-to-workspace = 1;
              "Super+2".action.focus-workspace = 2;
              "Super+Ctrl+2".action.move-column-to-workspace = 2;
              "Super+3".action.focus-workspace = 3;
              "Super+Ctrl+3".action.move-column-to-workspace = 3;
              "Super+4".action.focus-workspace = 4;
              "Super+Ctrl+4".action.move-column-to-workspace = 4;
              "Super+5".action.focus-workspace = 5;
              "Super+Ctrl+5".action.move-column-to-workspace = 5;
              "Super+6".action.focus-workspace = 6;
              "Super+Ctrl+6".action.move-column-to-workspace = 6;
              "Super+7".action.focus-workspace = 7;
              "Super+Ctrl+7".action.move-column-to-workspace = 7;
              "Super+8".action.focus-workspace = 8;
              "Super+Ctrl+8".action.move-column-to-workspace = 8;
              "Super+9".action.focus-workspace = 9;
              "Super+Ctrl+9".action.move-column-to-workspace = 9;
              "Super+Return".action.spawn = [ "ghostty" ];
              "Super+Backslash".action.spawn = [
                "1password"
                "--quick-access"
              ];
              "Super+N" = {
                action = {
                  spawn = [
                    "dms"
                    "ipc"
                    "call"
                    "notifications"
                    "toggle"
                  ];
                };
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
              "Super+Alt+L" = {
                action = {
                  spawn = [ "hyprlock" ];
                };
                allow-when-locked = true;
              };
              "Super+Shift+P" = {
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
