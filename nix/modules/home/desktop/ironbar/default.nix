{ ... }:
let
  main-bar = {
    anchor_to_edges = true;
    position = "top";
    icon_theme = "Paper";
    height = 32;

    start = [
      {
        type = "workspaces";
        all_monitors = false;
      }
    ];

    center = [
      {
        type = "focused";
        show_icon = true;
        show_title = true;
        icon_size = 32;
        truncate = "end";
      }
    ];

    end = [
      {
        type = "tray";
        icon_size = 32;
      }
      {
        type = "volume";
        format = "{icon} {percentage}%";
        max_volume = 100;
        icons = {
          volume_high = "󰕾";
          volume_medium = "󰖀";
          volume_low = "󰕿";
          muted = "󰝟";
        };
      }
      {
        type = "notifications";
        show_count = true;
        icons = {
          closed_none = "󰍥";
          closed_some = "󱥂";
          closed_dnd = "󱅯";
          open_none = "󰍡";
          open_some = "󱥁";
          open_dnd = "󱅮";
        };
      }
      {
        type = "clock";
        format = "%H:%M";
      }
    ];
  };
in
{
  programs.niri.settings = {
    spawn-at-startup = [ { command = [ "ironbar" ]; } ];
  };

  programs.ironbar = {
    enable = true;
    systemd = true;

    config = {
      monitors = {
        "DP-1" = main-bar;
        "DP-2" = main-bar;
        "eDP-1" = main-bar;
      };
    };
  };
}
