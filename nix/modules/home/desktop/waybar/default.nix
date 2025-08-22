{ lib, ... }:
let
  common = {
    layer = "top";
    position = "top";
    output = [ ]; # overridden per-bar
    height = 32;
    mod = "dock";
    exclusive = true;
    "gtk-layer-shell" = true;
    passthrough = false;
    "fixed-center" = true;
    reload_style_on_change = true;

    "modules-left" = [ "niri/workspaces" ];
    "modules-center" = [ "niri/window" ];

    tray = {
      "icon-size" = 16;
      spacing = 32;
    };

    "niri/workspaces" = {
      format = "{icon}";
      "format-icons" = {
        default = "●";
      };
    };

    "niri/window" = {
      "separate-outputs" = true;
      icon = true;
      format = " ";
    };

    battery = {
      states = {
        good = 95;
        warning = 30;
        critical = 15;
      };
      format = "<span size='small'>{icon}</span>";
      "format-charging" = "<span size='small'>󰢝</span>";
      "format-plugged" = "<span size='small'>󰂄</span>";
      "format-alt" = "{capacity}% {time}";
      "format-icons" = [
        "󰁺"
        "󰁻"
        "󰁼"
        "󰁽"
        "󰁾"
        "󰁿"
        "󰂀"
        "󰂁"
        "󰂂"
        "󰁹"
      ];
      "tooltip-format" = "Battery at {capacity}%";
    };

    wireplumber = {
      format = "{icon}";
      "tooltip-format" = "{volume}%";
      "format-muted" = "󰝟";
      "on-click" = "pavucontrol";
      "on-click-right" = "helvum";
      "format-icons" = [
        "󰕿"
        "󰖀"
        "󰕾"
      ];
    };

    clock = {
      format = "{:%H:%M}";
      "tooltip-format" = "<big>{:%Y %B}</big>\n<tt><small>{calendar}</small></tt>";
    };

    "custom/notification" = {
      tooltip = false;
      format = "{icon}";
      "format-icons" = {
        notification = "<span foreground='red'><sup></sup></span>󰂚";
        none = "󰂜";
        "dnd-notification" = "<span foreground='red'><sup></sup></span>󰂛";
        "dnd-none" = "󰂛";
        "inhibited-notification" = "<span foreground='red'><sup></sup></span>󰂚";
        "inhibited-none" = "󰂜";
        "dnd-inhibited-notification" = "<span foreground='red'><sup></sup></span>󰂛";
        "dnd-inhibited-none" = "󰂛";
      };
      "return-type" = "json";
      "exec-if" = "which swaync-client";
      exec = "swaync-client -swb";
      "on-click" = "swaync-client -t -sw";
      "on-click-right" = "swaync-client -d -sw";
      escape = true;
    };
  };

  primary = common // {
    # Laptop panel + DP-1
    output = [
      "eDP-1"
      "DP-1"
    ];
    "modules-right" = [
      "tray"
      "wireplumber"
      "battery"
      "clock"
      "custom/notification"
    ];
  };

  secondary = common // {
    # DP-2 only, remove clock from modules-right
    output = [ "DP-2" ];
  };

in
{
  programs.waybar = {
    enable = true;
    systemd.enable = false;

    # Reuse your existing CSS file contents
    style = builtins.readFile ./style.css;

    # Two bar definitions
    settings = [
      primary
      secondary
    ];
  };
}
