{
  config,
  lib,
  pkgs,
  ...
}:
let
  makeCommand = command: { command = [ command ]; };
  wallpaper = config.stylix.image;
in
{
  services.swayosd.enable = true;

  services.gnome-keyring = {
    enable = true;
    components = [
      "pkcs11"
      "secrets"
      "ssh"
    ];
  };

  services.cliphist = {
    enable = true;
  };
  systemd.user.services.cliphist = {
    User.ConditionEnvironment = "XDG_CURRENT_DESKTOP=niri";
  };
  systemd.user.services.cliphist-images = {
    User.ConditionEnvironment = "XDG_CURRENT_DESKTOP=niri";
  };

  systemd.user.services = {
    polkit-gnome = {
      Unit = {
        Description = "PolicyKit Authentication Agent provided by niri-flake";
        WantedBy = [ "niri.service" ];
        After = [ "graphical-session.target" ];
        PartOf = [ "graphical-session.target" ];
      };
      Service = {
        Type = "simple";
        ExecCondition = "${pkgs.bash}/bin/bash -c 'pgrep -x niri'";
        ExecStart = "${pkgs.polkit_gnome}/libexec/polkit-gnome-authentication-agent-1";
        Restart = "on-failure";
        RestartSec = 1;
        TimeoutStopSec = 10;
      };
      Install = {
        WantedBy = [ "graphical-session.target" ];
      };
    };

    swaync = {
      Unit = {
        Description = "SwayNotificationCenter for niri";
        Documentation = "https://github.com/ErikReider/SwayNotificationCenter";
        PartOf = [ "graphical-session.target" ];
        After = [ "graphical-session-pre.target" ];
      };

      Service = {
        Type = "simple";
        ExecCondition = "${pkgs.bash}/bin/bash -c 'pgrep -x niri'";
        ExecStart = "${pkgs.swaynotificationcenter}/bin/swaync";
        Restart = "on-failure";
        RestartSec = "1s";
      };

      Install = {
        WantedBy = [ "graphical-session.target" ];
      };
    };

    swww = {
      Unit = {
        Description = "Efficient animated wallpaper daemon for wayland";
        PartOf = [ "graphical-session.target" ];
        After = [ "graphical-session.target" ];
      };
      Install.WantedBy = [ "graphical-session.target" ];
      Service = {
        Type = "simple";
        ExecCondition = "${pkgs.bash}/bin/bash -c 'pgrep -x niri'";
        ExecStart = ''
          ${pkgs.swww}/bin/swww-daemon
        '';
        ExecStop = "${pkgs.swww}/bin/swww kill";
        Restart = "on-failure";
      };
    };

    waybar = {
      Unit = {
        Description = "Waybar for niri";
        Documentation = "https://github.com/Alexays/Waybar/wiki";
        PartOf = [ "graphical-session.target" ];
        After = [ "graphical-session-pre.target" ];
      };

      Service = {
        Type = "simple";
        ExecCondition = "${pkgs.bash}/bin/bash -c 'pgrep -x niri'";
        ExecStart = "${pkgs.waybar}/bin/waybar";
        ExecReload = "${pkgs.coreutils}/bin/kill -SIGUSR2 $MAINPID";
        Restart = "on-failure";
        RestartSec = "1s";
      };

      Install = {
        WantedBy = [ "graphical-session.target" ];
      };
    };
  };

  programs.fuzzel = {
    enable = true;
    settings = {
      main = {
        show-actions = true;
        width = 64;
        tabs = 4;
      };
    };
  };

  services.hypridle = {
    enable = true;
    settings = {
      general = {
        # Avoid starting multiple instances of hyprlock.
        # Then show the startup reminder after the lock has
        # ended.
        lock_cmd = "(pidof hyprlock || ${pkgs.hyprlock}); startup-reminder";

        before_sleep_cmd = "loginctl lock-session; sleep 1;";
        # After waking up, sometimes the timeout listener for shutting off the
        # screens will shut them off again. Wait for that to settle…
        after_sleep_cmd = "sleep 0.5; niri msg action power-on-monitors";
      };

      listener = [
        # Monitor power save
        {
          timeout = 720; # 12 min
          on-timeout = "niri msg action power-off-monitors";
          on-resume = "niri msg action power-on-monitors";
        }

        # Dim screen
        {
          timeout = 300; # 5 min
          on-timeout = "${pkgs.brightnessctl} -s set 10";
          on-resume = "${pkgs.brightnessctl} -r";
        }
        # Dim keyboard
        {
          timeout = 300; # 5 min
          on-timeout = "${pkgs.brightnessctl} -sd rgb:kbd_backlight set 0";
          on-resume = "${pkgs.brightnessctl} -rd rgb:kbd_backlight";
        }

        {
          timeout = 600; # 10 min
          on-timeout = "loginctl lock-session";
        }
      ];
    };
  };

  programs.niri = {

    settings = {
      environment = {
        DISPLAY = ":0";
        QT_QPA_PLATFORM = "wayland";
        XDG_CURRENT_DESKTOP = "niri";
        XDG_SESSION_TYPE = "wayland";
      };

      spawn-at-startup = [
        (makeCommand "blueman-applet")
        (makeCommand "swww img ${wallpaper}")
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
          transform.rotation = 180;
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

      # Nix attribute sets are ordered alphabetically when evaludated,
      # so we use 01/02/etc to force the order of workspaces; which Niri
      # relies on to determine the order of workspaces.
      workspaces = {
        "01" = {
          name = "Web";
          open-on-output = "DP-1";
        };

        "02" = {
          name = "Code";
          open-on-output = "DP-2";
        };

        "03" = {
          name = "Chat";
          open-on-output = "DP-1";
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

        border.enable = true;

        center-focused-column = "on-overflow";

        # struts = {
        #   left = 64;
        #   right = 64;
        #   top = 4;
        #   bottom = 4;
        # };

        default-column-width = {
          proportion = 0.5;
        };

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
        "Super+Space" = {
          action = {
            spawn = [ "fuzzel" ];
          };
        };
        "Super+C" = {
          action = {
            spawn = [
              "bash"
              "-c"
              "cliphist list | fuzzel --dmenu --prompt='Copy to Clipboard:' | cliphist decode | wl-copy"
            ];
          };
        };
        "Super+T" = {
          action.toggle-column-tabbed-display = { };
        };

        "Super+E" = {
          action = {
            spawn = [ "bemoji" ];
          };
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

        "Super+Page_Up" = {
          action.focus-workspace-up = { };
        };

        "Super+Page_Down" = {
          action.focus-workspace-down = { };
        };

        "Super+Shift+Page_Up" = {
          action.move-column-to-workspace-up = { };
        };

        "Super+Shift+Page_Down" = {
          action.move-column-to-workspace-down = { };
        };

        "Super+Control+Down" = {
          action.move-column-to-monitor-down = { };
        };

        "Super+Control+Up" = {
          action.move-column-to-monitor-up = { };
        };

        "Super+Control+Left" = {
          action.move-column-to-monitor-left = { };
        };

        "Super+Control+Right" = {
          action.move-column-to-monitor-right = { };
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
          action = {
            spawn = [
              "brightnessctl"
              "s"
              "10%+"
            ];
          };
        };
        "XF86MonBrightnessDown" = {
          action = {
            spawn = [
              "brightnessctl"
              "s"
              "10%-"
            ];
          };
        };
        "Super+L" = {
          action = {
            spawn = [ "hyprlock" ];
          };
          allow-inhibiting = false;
        };
        "Super+Shift+L" = {
          action.power-off-monitors = { };
        };
      };
    };
  };

  stylix.targets.waybar.enable = lib.mkForce false;
  stylix.targets.niri.enable = lib.mkDefault true;

  xdg.configFile."swaync/config.json".text = ''
    {
      "positionX": "right",
      "positionY": "top",
      "layer": "overlay",
      "control-center-margin-top": 0,
      "control-center-margin-bottom": 0,
      "control-center-margin-right": 0,
      "control-center-margin-left": 0,
      "notification-2fa-action": true,
      "notification-inline-replies": false,
      "notification-icon-size": 64,
      "notification-body-image-height": 100,
      "notification-body-image-width": 200,
      "timeout": 10,
      "timeout-low": 5,
      "timeout-critical": 0,
      "fit-to-screen": true,
      "control-center-width": 500,
      "control-center-height": 600,
      "notification-window-width": 500,
      "keyboard-shortcuts": true,
      "image-visibility": "when-available",
      "transition-time": 200,
      "hide-on-clear": false,
      "hide-on-action": true,
      "script-fail-notify": true,
      "scripts": {
        "example-script": {
          "exec": "echo 'Do something...'",
          "urgency": "Normal"
        }
      },
      "notification-visibility": {
        "example-name": {
          "state": "muted",
          "urgency": "Low",
          "app-name": "Spotify"
        }
      },
      "widgets": [
        "title",
        "buttons-grid",
        "mpris",
        "volume",
        "backlight",
        "dnd",
        "notifications"
      ],
      "widget-config": {
        "title": {
          "text": "Notification Center",
          "clear-all-button": true,
          "button-text": "Clear All"
        },
        "dnd": {
          "text": "Do Not Disturb"
        },
        "label": {
          "max-lines": 5,
          "text": "Label Text"
        },
        "mpris": {
          "image-size": 96,
          "image-radius": 12
        },
        "volume": {
          "expand-button-label": "⏷",
          "collapse-button-label": "⏶",
          "show-per-app": true
        },
        "backlight": {
          "device": "intel_backlight",
          "subsystem": "backlight"
        },
        "buttons-grid": {
          "actions": [
            {
              "label": "⚡",
              "command": "systemctl poweroff"
            },
            {
              "label": "🔃",
              "command": "systemctl reboot"
            },
            {
              "label": "🔒",
              "command": "swaylock"
            },
            {
              "label": "🚪",
              "command": "niri msg logout"
            },
            {
              "label": "⏸️",
              "command": "systemctl suspend"
            }
          ]
        }
      }
    }
  '';
}
