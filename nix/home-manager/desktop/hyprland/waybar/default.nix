{ hostname, lib, ... }:
{
  programs.waybar = {
    enable = true;
    systemd.enable = true;
    systemd.target = "hyprland-session.target";

    catppuccin = {
      enable = true;
      mode = "createLink";
    };

    settings = {
      mainBar = {
        layer = "top";
        position = "top";

        modules-left = [ "hyprland/workspaces" ];

        modules-center = [ "hyprland/window" ];

        modules-right =
          lib.optionals (hostname == "laptop") [
            "battery"
            "backlight"
          ]
          ++ [
            "tray"
            "wireplumber"
            "clock"
          ];

        backlight = {
          device = "intel_backlight";
          format = "{percent}% {icon}";
          format-icons = [
            ""
            ""
            ""
            ""
            ""
            ""
            ""
          ];
        };

        battery = {
          interval = 60;
          states = {
            warning = 30;
            critical = 15;
          };
          format = "{icon} {capacity}%";
          format-charging = "<span color=\"#e0af68\">󱐌</span> {capacity}%";
          format-icons = [
            "<span color=\"#f7768e\"> </span>"
            "<span color=\"#f7768e\"> </span>"
            "<span color=\"#7aa2f7\"> </span>"
            "<span color=\"#7aa2f7\"> </span>"
            "<span color=\"#7aa2f7\"> </span>"
          ];
          on-update = "$HOME/.config/waybar/scripts/check_battery.sh";
        };

        clock = {
          format = "{:%H:%M}";
        };

        "hyprland/window" = {
          max-length = 64;
          separate-outputs = true;
          icon = true;
        };

        "hyprland/workspaces" = {
          format = "{icon}";
          on-click = "activate";
          disable-scroll = true;
        };

        tray = {
          icon-size = 12;
          spacing = 6;
        };

        wireplumber = {
          scroll-step = 5;
          format = "{icon} {volume}%";
          format-muted = "🔇";
          format-bluetooth = "🫐 {volume}%";
          on-click-right = "blueman-manager";
          on-click = "pavucontrol";
          format-icons = [
            "🔈"
            "🔉"
            "🔊"
          ];
        };
      };
    };

    style =
      let
        accent = "mauve";
      in
      ''
        @import "catppuccin.css";

        * {
          font-family:
            "Monaspace Krypton",
            feather;
          font-weight: 500;
          font-size: 11pt;
          color: @text;
        }

        /* main waybar */
        window#waybar {
          padding: 0;
          margin: 0;
          /* background: rgba(26, 27, 38, 0.7); */
          background: @base;
        }

        /* when hovering over modules */
        tooltip {
          background: @base;
          border-radius: 5%;
        }

        #workspaces button {
          padding: 2px;
        }

        /* Sets active workspace to have a solid line on the bottom */
        #workspaces button.active {
          border-bottom: 2px solid @${accent};
          border-radius: 0;
          margin-top: 2px;
          transition: all 0.5s ease-in-out;
        }

        /* More workspace stuff for highlighting on hover */
        #workspaces button.focused {
          color: @subtext0;
        }

        #workspaces button.urgent {
          color: #f7768e;
        }

        #workspaces button:hover {
          background: @crust;
          color: @text;
        }

        /* Sets background, padding, margins, and borders for (all) modules */
        #workspaces,
        #clock,
        #window,
        #temperature,
        #disk,
        #cpu,
        #memory,
        #network,
        #wireplumber,
        #tray,
        #backlight,
        #battery {
          /* background: rgba(26, 27, 38, 0); */
          background: @base;
          padding: 0 10px;
          border: 0;
        }

        #workspaces {
          padding-right: 0px;
        }

        /* Hide window module when not focused on window or empty workspace */
        window#waybar.empty #window {
          padding: 0;
          margin: 0;
          opacity: 0;
        }

        /* Set up rounding to make these modules look like separate pills */
        #tray {
          color: @${accent};
          border-radius: 12px;
          margin-right: 4px;
        }

        #window {
          border-radius: 12px;
        }

        /* close right side of bar */
        #temperature {
          border-radius: 12px 0 0 12px;
        }

        /* close left side of bar */
        #battery {
          border-radius: 0 12px 12px 0;
        }
      '';
  };
}
