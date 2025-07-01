{ pkgs, ... }:
{
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

  xdg.configFile."niri/config.kdl".source = ./config.kdl;
  xdg.configFile."fuzzel/fuzzel.ini".source = ./fuzzel/config.ini;
  xdg.configFile."swaylock/config".source = ./swaylock/config;

  services.clipcat.enable = true;

  xdg.configFile."xdg-desktop-portal/portals.conf".text = ''
    [preferred]
    default=gnome;gtk
    org.freedesktop.impl.portal.FileChooser=gtk
    org.freedesktop.impl.portal.ScreenCast=gnome
    org.freedesktop.impl.portal.Screenshot=gnome
  '';

  xdg.configFile."waybar/config.jsonc".source = ./waybar/config.jsonc;
  xdg.configFile."waybar/style-common.css".source = ./waybar/style-common.css;
  xdg.configFile."waybar/style-dark.css".source = ./waybar/style-dark.css;
  xdg.configFile."waybar/style-light.css".source = ./waybar/style-light.css;

  xdg.configFile."darkman/config.yaml".text = ''
    lat: 53.544389
    lng: -113.490927
    dbusserver: true
    portal: true
    pollingfreq: 5
    sunrise: "7:00"
    sunset: "17:00"
  '';

  services.darkman = {
    enable = true;
    settings = {
      usegeoclue = true;
    };
  };

  xdg.configFile."darkman/dark-mode.d/fish.sh" = {
    executable = true;
    text = ''
      #!/usr/bin/env bash
      fish -c "yes | fish_config theme save 'Catppuccin Mocha'"
    '';
  };

  xdg.configFile."darkman/dark-mode.d/gtk.sh" = {
    executable = true;
    text = ''
      #!/usr/bin/env bash
      gsettings set org.gnome.desktop.interface gtk-theme 'Catppuccin-Mocha-Standard-Rose-Dark'
      gsettings set org.gnome.desktop.interface color-scheme 'prefer-dark'
    '';
  };

  xdg.configFile."darkman/dark-mode.d/niri.nu" = {
    executable = true;
    text = ''
      #!/usr/bin/env nu
      try { ln -sf ~/.config/waybar/style-dark.css ~/.config/waybar/style.css }
    '';
  };

  xdg.configFile."darkman/dark-mode.d/zellij.sh" = {
    executable = true;
    text = ''
      #!/usr/bin/env bash
      ln -sf ~/.config/zellij/themes/catppuccin-mocha.kdl ~/.config/zellij/theme.kdl
    '';
  };

  xdg.configFile."darkman/light-mode.d/fish.sh" = {
    executable = true;
    text = ''
      #!/usr/bin/env bash
      fish -c "yes | fish_config theme save 'Catppuccin Latte'"
    '';
  };

  xdg.configFile."darkman/light-mode.d/gtk.sh" = {
    executable = true;
    text = ''
      #!/usr/bin/env bash
      gsettings set org.gnome.desktop.interface gtk-theme 'Catppuccin-Latte-Standard-Rose-Light'
      gsettings set org.gnome.desktop.interface color-scheme 'prefer-light'
    '';
  };

  xdg.configFile."darkman/light-mode.d/niri.nu" = {
    executable = true;
    text = ''
      #!/usr/bin/env nu
      try { ln -sf ~/.config/waybar/style-light.css ~/.config/waybar/style.css }
    '';
  };

  xdg.configFile."darkman/light-mode.d/zellij.sh" = {
    executable = true;
    text = ''
      #!/usr/bin/env bash
      ln -sf ~/.config/zellij/themes/catppuccin-latte.kdl ~/.config/zellij/theme.kdl
    '';
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

  home.file.".local/bin/fuzzel-window-picker" = {
    executable = true;
    text = ''
      #!/usr/bin/env bash
      niri msg windows | jq -r '.[] | "\(.id) \(.app_id // .title)"' | fuzzel --dmenu | cut -d' ' -f1 | xargs -r niri msg window focus --id
    '';
  };
}
