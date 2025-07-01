{ config
, lib
, pkgs
, ...
}:
{
  home.packages = with pkgs; [
    # Core niri dependencies
    niri
    xwayland-satellite

    # Clipboard management
    clipcat
    wl-clipboard
    cliphist

    # Screen management
    swayidle
    swaylock
    brightnessctl

    # Notification daemon
    swaynotificationcenter

    # Wallpaper
    swww

    # App launcher
    fuzzel
    bemoji

    # Status bar
    waybar

    # Dark/light mode switcher
    darkman

    # Authentication agent
    polkit_gnome

    # Screenshot utilities
    grim
    slurp

    # Other utilities
    blueman
    pavucontrol
  ];

  # Main niri configuration
  xdg.configFile."niri/config.kdl".text = ''
    ${builtins.readFile ./config.kdl}
  '';

  services.clipcat.enable = true;

  # Fuzzel configuration
  xdg.configFile."fuzzel/fuzzel.ini".text = ''
    [main]
    font=Monaspace Neon:size=16
    prompt=" "
    layer=overlay
    width=35
    lines=10
    horizontal-pad=20
    vertical-pad=8

    [colors]
    background=0D0D0D99
    text=EEEEEEff
    match=9d79d6ff
    selection=b8bb262e
    selection-text=EEEEEEff
    selection-match=9d79d6ff

    [border]
    width=3
    radius=10

    [dmenu]
    exit-immediately-if-empty=yes
  '';

  # Swaylock configuration
  xdg.configFile."swaylock/config".text = ''
    ignore-empty-password
    font=Monaspace Neon
    font-size=24

    clock
    timestr=%I:%M %p
    datestr=%A, %B %d

    # Background
    screenshots
    effect-blur=10x5
    effect-vignette=0.5:0.5
    fade-in=0.2

    # Colors
    inside-color=1e1e2e00
    inside-clear-color=f5e0dc00
    inside-ver-color=89b4fa00
    inside-wrong-color=f38ba800
    ring-color=b4befeff
    ring-clear-color=f5e0dcff
    ring-ver-color=89b4faff
    ring-wrong-color=f38ba8ff
    line-color=1e1e2eff
    line-clear-color=f5e0dcff
    line-ver-color=89b4faff
    line-wrong-color=f38ba8ff
    text-color=cdd6f4ff
    text-clear-color=f5e0dcff
    text-ver-color=89b4faff
    text-wrong-color=f38ba8ff
    key-hl-color=a6e3a1ff
    bs-hl-color=f38ba8ff
    caps-lock-key-hl-color=fab387ff
    caps-lock-bs-hl-color=f38ba8ff
    separator-color=1e1e2e00

    # Indicator
    indicator-radius=100
    indicator-thickness=10
    indicator-x-position=50
    indicator-y-position=800
  '';

  # Portal configuration
  xdg.configFile."xdg-desktop-portal/portals.conf".text = ''
    [preferred]
    default=gnome;gtk
    org.freedesktop.impl.portal.FileChooser=gtk
    org.freedesktop.impl.portal.ScreenCast=gnome
    org.freedesktop.impl.portal.Screenshot=gnome
  '';

  # Waybar configuration
  xdg.configFile."waybar/config.jsonc".source = ./waybar/config.jsonc;
  xdg.configFile."waybar/style-dark.css".source = ./waybar/style-dark.css;
  xdg.configFile."waybar/style-light.css".source = ./waybar/style-light.css;

  # Darkman configuration
  xdg.configFile."darkman/config.yaml".text = ''
    lat: 53.544389
    lng: -113.490927
    dbusserver: true
    portal: true
    pollingfreq: 5
    sunrise: "7:00"
    sunset: "17:00"
  '';

  # Darkman mode scripts
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

  # SwayNC configuration
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

  # Fuzzel window picker script
  home.file.".local/bin/fuzzel-window-picker" = {
    executable = true;
    text = ''
      #!/usr/bin/env bash
      niri msg windows | jq -r '.[] | "\(.id) \(.app_id // .title)"' | fuzzel --dmenu | cut -d' ' -f1 | xargs -r niri msg window focus --id
    '';
  };
}
