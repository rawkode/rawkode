{ config, pkgs, ... }:
let
  makeCommand = command: { command = [ command ]; };
in
{
  home.pointerCursor = {
    package = pkgs.catppuccin-cursors.latteLavender;
    name = "catppuccin-latte-lavender-cursors";
    size = 20;
    gtk.enable = true;
    x11.enable = true;
  };

  services.swayosd.enable = true;

  services.gnome-keyring = {
    enable = true;
    components = [
      "pkcs11"
      "secrets"
      "ssh"
    ];
  };

  dconf.settings = {
    "org/gnome/desktop/interface" = {
      cursor-theme = config.home.pointerCursor.name;
    };
  };

  programs.waybar = {
    enable = true;

    systemd.enable = false; # We'll configure our own service
  };

  systemd.user.services.waybar = {
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

  systemd.user.services.swaync = {
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

  programs.niri = {
    enable = true;
    settings = {
      environment = {
        DISPLAY = ":0";
        QT_QPA_PLATFORM = "wayland";
        XDG_CURRENT_DESKTOP = "niri";
        XDG_SESSION_TYPE = "wayland";
      };

      spawn-at-startup = [
        (makeCommand "${pkgs.polkit_gnome}/libexec/polkit-gnome-authentication-agent-1")
        (makeCommand "blueman-applet")
        {
          command = [
            "swayidle"
            "-w"
            "before-sleep"
            "swaylock -f"
            "timeout"
            "300"
            "niri msg output eDP-1 off"
            "resume"
            "niri msg output eDP-1 on"
          ];
        }
        (makeCommand "swww-daemon")
        {
          command = [
            "wl-paste"
            "--watch"
            "cliphist"
            "store"
          ];
        }
        (makeCommand "xwayland-satellite")
        {
          command = [
            "swww"
            "img"
            "~/.config/niri/wallpaper.png"
          ];
        }
      ];

      outputs = {
        "eDP-1" = {
          scale = 2.0;
          position = {
            x = 0;
            y = 0;
          };
        };
        "DP-1" = {
          scale = 2.0;
          position = {
            x = 0;
            y = 0;
          };
          focus-at-startup = true;
        };
        "DP-2" = {
          scale = 2.0;
        };
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
            y = 1080;
          };
        };
        "Samsung Electric Company LS32A70 HK2WB00305" = {
          scale = 1.75;
        };
      };

      workspaces = {
        "Web" = {
          open-on-output = "DP-1";
        };
        "Code" = {
          open-on-output = "DP-2";
        };
        "Chat" = {
          open-on-output = "DP-1";
        };
        "Teleprompter" = {
          open-on-output = "Invalid Vendor Codename - RTK Field Monitor J257M96B00FL";
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
        theme = config.home.pointerCursor.name;
        size = config.home.pointerCursor.size;
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

        focus-ring = {
          enable = true;
          width = 2;
          active.gradient = {
            from = "#ff00ff";
            to = "#00ffff";
            angle = 270;
            relative-to = "window";
          };
          inactive.gradient = {
            from = "#3a3a4a";
            to = "#5a5a6a";
            angle = 45;
            relative-to = "workspace-view";
          };
          urgent.gradient = {
            from = "#ff0000";
            to = "#ffff00";
            angle = 135;
          };
        };

        border = {
          enable = false;
        };

        shadow = {
          enable = true;
          softness = 50;
          spread = 15;
          offset = {
            x = 0;
            y = 12;
          };
          draw-behind-window = true;
          color = "#ff00ff40";
          inactive-color = "#00000030";
        };

        struts = {
          left = 64;
          right = 64;
          top = 4;
          bottom = 4;
        };

        default-column-width = {
          proportion = 1.0;
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
          matches = [
            { app-id = "Code"; }
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
        "Super+Shift+Space" = {
          action = {
            spawn = [ "~/.local/bin/fuzzel-window-picker" ];
          };
        };
        "Super+C" = {
          action = {
            spawn = [
              "sh"
              "-c"
              "clipcatctl list --no-id | fuzzel --dmenu | wl-copy"
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
        "Super+P" = {
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
            spawn = [ "swaylock" ];
          };
          allow-inhibiting = false;
        };
        "Super+Shift+L" = {
          action.power-off-monitors = { };
        };
      };
    };
  };

  xdg.configFile."fuzzel/fuzzel.ini".source = ./fuzzel/config.ini;
  xdg.configFile."swaylock/config".source = ./swaylock/config;

  services.clipcat.enable = true;

  xdg.configFile."waybar/config.jsonc".source = ./waybar/config.jsonc;
  xdg.configFile."waybar/style-common.css".source = ./waybar/style-common.css;
  xdg.configFile."waybar/style-dark.css".source = ./waybar/style-dark.css;
  xdg.configFile."waybar/style-light.css".source = ./waybar/style-light.css;

  services.darkman = {
    enable = true;

    settings.usegeoclue = true;

    darkModeScripts = {
      gtk = ''
        gsettings set org.gnome.desktop.interface color-scheme prefer-dark
      '';
    };

    lightModeScripts = {
      gtk = ''
        gsettings set org.gnome.desktop.interface color-scheme prefer-light
      '';
    };
  };

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
              "label": "󰐥",
              "command": "systemctl poweroff"
            },
            {
              "label": "󰜉",
              "command": "systemctl reboot"
            },
            {
              "label": "󰌾",
              "command": "swaylock"
            },
            {
              "label": "󰍃",
              "command": "niri msg logout"
            },
            {
              "label": "󰏥",
              "command": "systemctl suspend"
            }
          ]
        }
      }
    }
  '';

  xdg.configFile."swaync/style.css".text = ''
    * {
      font-family: "Monaspace Neon", "MonaspiceNe Nerd Font";
      font-size: 14px;
    }

    /* Window */
    .control-center {
      background: #fdf6e3;
      color: #002b36;
      border-radius: 16px;
      margin: 16px;
    }

    .control-center-list {
      background: transparent;
    }

    .control-center-list-placeholder {
      opacity: 0.5;
    }

    /* Header */
    .widget-title {
      color: #002b36;
      font-size: 18px;
      font-weight: bold;
      margin: 16px;
    }

    .widget-title > button {
      background: #2aa198;
      color: #fdf6e3;
      border: none;
      border-radius: 8px;
      padding: 8px 16px;
      font-size: 14px;
      font-weight: bold;
    }

    .widget-title > button:hover {
      background: #268bd2;
    }

    /* Notifications */
    .notification {
      background: #eee8d5;
      color: #002b36;
      padding: 16px;
      margin: 8px 16px;
      border-radius: 12px;
      border: 1px solid #93a1a1;
    }

    .notification-default-action:hover .notification {
      background: #fdf6e3;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    }

    /* Notification content */
    .notification-content {
      color: #002b36;
    }

    .summary {
      font-size: 16px;
      font-weight: bold;
      color: #002b36;
    }

    .time {
      font-size: 12px;
      opacity: 0.7;
      margin-right: 24px;
    }

    .body {
      font-size: 14px;
      opacity: 0.8;
    }

    /* Action buttons */
    .widget-buttons-grid {
      padding: 16px;
      margin: 0;
    }

    .widget-buttons-grid > flowbox > flowboxchild > button {
      background: #93a1a1;
      color: #002b36;
      border: none;
      border-radius: 12px;
      padding: 16px;
      margin: 4px;
      font-size: 20px;
    }

    .widget-buttons-grid > flowbox > flowboxchild > button:hover {
      background: #eee8d5;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    }

    /* Volume widget */
    .widget-volume {
      background: #eee8d5;
      padding: 16px;
      margin: 8px 16px;
      border-radius: 12px;
    }

    .widget-volume > box > button {
      background: #93a1a1;
      border: none;
      border-radius: 8px;
      padding: 8px;
      margin: 0 8px;
    }

    .widget-volume > box > button:hover {
      background: #839496;
    }

    scale trough {
      all: unset;
      background: #93a1a1;
      border-radius: 8px;
      min-height: 8px;
      min-width: 80px;
      margin: 0 16px;
    }

    scale trough highlight {
      all: unset;
      background: #2aa198;
      border-radius: 8px;
    }

    scale trough slider {
      all: unset;
      background: #268bd2;
      border-radius: 50%;
      min-width: 16px;
      min-height: 16px;
      margin: -4px 0;
    }

    /* DND widget */
    .widget-dnd {
      margin: 8px 16px;
      font-size: 14px;
      color: #002b36;
    }

    .widget-dnd > switch {
      background: #93a1a1;
      border-radius: 16px;
    }

    .widget-dnd > switch:checked {
      background: #2aa198;
    }

    .widget-dnd > switch slider {
      all: unset;
      background: #fdf6e3;
      border-radius: 50%;
      min-width: 22px;
      min-height: 22px;
      margin: 3px;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
    }

    /* Close button */
    .close-button {
      background: #dc322f;
      color: #fdf6e3;
      text-shadow: none;
      border-radius: 50%;
      padding: 0;
      margin: 0;
      box-shadow: none;
      border: none;
      min-width: 24px;
      min-height: 24px;
    }

    .close-button:hover {
      background: #cb4b16;
    }
  '';

  home.file.".local/bin/fuzzel-window-picker" = {
    executable = true;
    text = ''
      #!/usr/bin/env bash
      niri msg windows | jq -r '.[] | "\(.id) \(.app_id // .title)"' | fuzzel --dmenu | cut -d' ' -f1 | xargs -r niri msg window focus --id
    '';
  };
}
