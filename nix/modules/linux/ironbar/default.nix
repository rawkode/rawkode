let
  main_bar = {
    anchor_to_edges = true;
    position = "top";
    height = 16;
    start = [
      {
        type = "workspaces";
        sort = "added";
      }
    ];
    center = [
      {
        type = "clock";
        format = "%H:%M";
        justify = "center";
      }
    ];
    end = [
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
        on_click_left = "pavucontrol";
        disable_popup = true;
      }
      {
        type = "tray";
        icon_size = 32;
      }
      {
        type = "battery";
        icon_size = 32;
      }
    ];
  };
in
{
  flake.homeModules.ironbar =
    { config, lib, ... }:
    {
      programs.ironbar = {
        enable = true;
        systemd = true;

        config = {
          icon_theme = "rose-pine";

          monitors = {
            eDP-1 = main_bar;
            DP-1 = main_bar;
            DP-2 = main_bar // {
              # Hide clock and tray on second monitor
              center = [ ];
              end = [ ];
            };
          };
        };
        style = ''
          * {
            font-family: "Monaspace Neon";
            font-size: 16px;
            text-shadow: 2px 2px ${config.lib.stylix.colors.withHashtag.base00};
            border: none;
            border-radius: 0;
            outline: none;
            font-weight: 500;
            background: none;
            color: ${config.lib.stylix.colors.withHashtag.base05};
          }

          .background {
            background: alpha(${config.lib.stylix.colors.withHashtag.base00}, 0.925);
          }

          .workspaces {
            padding-left: 1em;
            padding-right: 1em;
          }

          .workspaces .item {
            padding-left: 1em;
            padding-right: 1em;
          }

          .workspaces .item.focused {
            box-shadow: inset 0 -2px 0 ${config.lib.stylix.colors.withHashtag.base0D};
          }

          .volume {
            padding-left: 1em;
            padding-right: 1em;
            color: ${config.lib.stylix.colors.withHashtag.base0C};
          }

          .volume:hover {
            color: ${config.lib.stylix.colors.withHashtag.base0D};
            background: alpha(${config.lib.stylix.colors.withHashtag.base02}, 0.3);
            border-radius: 4px;
          }

          /* Volume popup */
          .popup-volume {
            padding: 1em;
            background: alpha(${config.lib.stylix.colors.withHashtag.base00}, 0.95);
            border: 1px solid ${config.lib.stylix.colors.withHashtag.base02};
          }

          .popup-volume scale trough {
            min-height: 6px;
            background-color: ${config.lib.stylix.colors.withHashtag.base02};
            border-radius: 3px;
          }

          .popup-volume scale slider {
            min-width: 12px;
            min-height: 12px;
            background-color: ${config.lib.stylix.colors.withHashtag.base0C};
            border-radius: 50%;
          }

          .popup-volume scale slider:hover {
            background-color: ${config.lib.stylix.colors.withHashtag.base0D};
          }

          .battery  {
            padding-right: 1em;
          }

          .tray {
            padding-left: 1em;
            padding-right: 1em;
          }

          .tray .item {
            padding-left: 1em;
            padding-right: 1em;
          }
        '';
      };

      # Override the systemd service to ensure it starts after compositor is ready
      systemd.user.services.ironbar = {
        Unit = {
          # Start for any Wayland display
          ConditionEnvironment = lib.mkForce [ "WAYLAND_DISPLAY" ];
          After = [ "graphical-session.target" ];
        };
        Service = {
          # Add a small delay to ensure compositor is fully initialized
          ExecStartPre = "/run/current-system/sw/bin/sleep 2";
        };
      };
    };
}
