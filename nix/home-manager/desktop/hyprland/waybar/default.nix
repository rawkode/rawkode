{
  hostname,
  lib,
  pkgs,
  ...
}:
let
  bluetoothToggle = pkgs.writeShellApplication {
    name = "bluetooth-toggle";
    runtimeInputs = with pkgs; [
      bluez
      gnugrep
    ];
    text = ''
      if [[ "$(bluetoothctl show | grep -Po "Powered: \K(.+)$")" =~ no ]]; then
        bluetoothctl power on
        bluetoothctl discoverable on
      else
        bluetoothctl power off
      fi
    '';
  };

  sessionMenu = pkgs.writeShellApplication {
    name = "session-menu";
    runtimeInputs = with pkgs; [
      fuzzel
      notify-desktop
    ];
    text = ''
      host=$(hostname -s)
      shutdown="🔘 Power Off"
      reboot="♻️ Reboot"
      suspend="💤 Suspend"
      logout="👋 Log Out"
      lock="🔒️ Lock"

      selected=$(
        echo -e "$shutdown\n$reboot\n$logout\n$lock" |
        fuzzel --dmenu --prompt "⚙️ Session > " --lines 4)
      case $selected in
        "$shutdown")
          notify-desktop "$shutdown" "Shutting down: $host."
          sleep 2
          systemctl poweroff;;
        "$reboot")
          notify-desktop "$reboot" "Rebooting: $host."
          sleep 2
          systemctl reboot;;
        "$suspend")
          notify-desktop "$suspend" "Suspending: $host."
          sleep 2
          systemctl suspend;;
        "$logout")
          notify-desktop "$logout" "Logging out $USER on $host."
          sleep 1
          hyprctl dispatch exit;;
        "$lock")
          notify-desktop "$lock" "Locking: $host."
          sleep 2
          hyprlock --immediate;;
      esac
    '';
  };
in
{
  programs = {
    waybar = {
      enable = true;
      catppuccin.mode = "createLink";

      systemd = {
        enable = true;
        target = "graphical-session.target";
      };

      style = ./style.css;

      settings = [
        {
          # output = if hostname == "desktop" then "DP-1" else "eDP-1";

          exclusive = true;
          passthrough = false;
          reload_style_on_change = true;

          layer = "top";
          position = "top";

          modules-left = [ "hyprland/workspaces" ];

          modules-center = [ "clock" ];

          modules-right = [
            "tray"
            "wireplumber"
            "pulseaudio"
            "network"
            "bluetooth"
            "backlight"
            "power-profiles-daemon"
            "temperature"
            "battery"
            "custom/session"
          ];

          "hyprland/workspaces" = {
            active-only = false;
            format = "<big>{icon}</big>";
            "persistent_workspaces" = {
              "1" = [
                "DP-1"
                "eDP-1"
              ];
              "2" = [
                "DP-1"
                "eDP-1"
              ];
              "3" = [
                "DP-1"
                "eDP-1"
              ];
              "4" = [
                "DP-1"
                "eDP-1"
              ];
              "5" = [
                "DP-1"
                "eDP-1"
              ];
              "6" = [ "DP-2" ];
              "7" = [ "DP-2" ];
              "8" = [ "DP-2" ];
              "9" = [ "DP-2" ];
              "0" = [ "DP-2" ];
            };
            on-click = "activate";
          };
          idle_inhibitor = {
            format = "<big>{icon}</big>";
            format-icons = {
              activated = "";
              deactivated = "";
            };
            start-activated = false;
            tooltip-format-activated = " Presentation mode: {status}";
            tooltip-format-deactivated = " Presentation mode: {status}";
          };
          clock = {
            format = "<small>{:%H:%M}</small>";
            format-alt = "<small>{:%a, %d %b %R}</small>";
            timezone = "Europe/London";
            tooltip-format = "<big>{:%Y %B}</big>\n<tt><small>{calendar}</small></tt>";
          };
          tray = {
            icon-size = 22;
            spacing = 12;
          };
          wireplumber = {
            scroll-step = 5;
            format = "<big>{icon}</big>";
            format-alt = "<big>{icon}</big> <small>{volume}%</small>";
            format-muted = "";
            format-icons = {
              default = [
                ""
                ""
                ""
              ];
            };
            max-volume = 100;
            on-click-middle = "${pkgs.avizo}/bin/volumectl toggle-mute";
            on-click-right = "${lib.getExe pkgs.pwvucontrol}";
            on-scroll-up = "${pkgs.avizo}/bin/volumectl -u up 2";
            on-scroll-down = "${pkgs.avizo}/bin/volumectl -u down 2";
            tooltip-format = " {volume}% / {node_name}";
          };
          pulseaudio = {
            format = "<big>{format_source}</big>";
            format-alt = "<big>{format_source}</big> <small>{source_volume}%</small>";
            format-source = "";
            format-source-muted = "";
            on-click-middle = "${pkgs.avizo}/bin/volumectl -m toggle-mute";
            on-click-right = "${lib.getExe pkgs.pwvucontrol}";
            on-scroll-up = "${pkgs.avizo}/bin/volumectl -m up 2";
            on-scroll-down = "${pkgs.avizo}/bin/volumectl -m down 2";
            tooltip-format = " {source_volume}% / {desc}";
          };
          network = {
            format = "<big>{icon}</big>";
            format-alt = " <small>{bandwidthDownBits}</small>   <small>{bandwidthUpBits}</small>";
            format-ethernet = "󰈀";
            format-disconnected = "󰖪";
            format-linked = "";
            format-wifi = "";
            interval = 2;
            on-click-right = "${pkgs.networkmanagerapplet}/bin/nm-connection-editor";
            tooltip-format = " {ifname}\n󱦂 {ipaddr} via {gwaddr}\n {bandwidthDownBits}\t {bandwidthUpBits}";
            tooltip-format-wifi = " {essid} {signalStrength}%\n󱦂 {ipaddr} via {gwaddr}\n {bandwidthDownBits}\t {bandwidthUpBits}";
            tooltip-format-ethernet = "󰈀 {ifname}\n󱦂 {ipaddr} via {gwaddr})\n {bandwidthDownBits}\t {bandwidthUpBits}";
            tooltip-format-disconnected = "󰖪 Disconnected";
          };
          bluetooth = {
            format = "<big>{icon}</big>";
            format-connected = "󰂱";
            format-disabled = "󰂲";
            format-on = "󰂯";
            format-off = "󰂲";
            on-click-middle = "${lib.getExe bluetoothToggle}";
            on-click-right = "${lib.getExe pkgs.overskride}";
            tooltip-format = "󰂯 {controller_alias}\t{controller_address}\n{num_connections} connected";
            tooltip-format-connected = "󰂱 {controller_alias}\t{controller_address}\n{num_connections} connected\n{device_enumerate}";
            tooltip-format-disabled = "󰂲 {controller_alias}\t{controller_address}\n{status}";
            tooltip-format-enumerate-connected = "󰂱 {device_alias}\t{device_address}";
            tooltip-format-enumerate-connected-battery = "󰂱 {device_alias}\t{device_address}\t{device_battery_percentage}%";
            tooltip-format-off = "󰂲 {controller_alias}\t{controller_address}\n{status}";
          };
          backlight = {
            device = "thinkpad_acpi";
            format = "<big>{icon}</big>";
            format-alt = "<big>{icon}</big> <small>{percent}%</small>";
            format-icons = [
              ""
              ""
              ""
              ""
              ""
              ""
              ""
              ""
              ""
            ];
            on-click-middle = "${pkgs.avizo}/bin/lightctl set 50";
            on-scroll-up = "${pkgs.avizo}/bin/lightctl up 2";
            on-scroll-down = "${pkgs.avizo}/bin/lightctl down 2";
            tooltip-format = " {percent}%";
          };
          power-profiles-daemon = {
            format = "<big>{icon}</big>";
            format-icons = {
              default = "";
              performance = "";
              balanced = "";
              power-saver = "";
            };
            tooltip-format = " Power profile: {profile}\n Driver: {driver}";
          };
          temperature = {
            thermal-zone = 0;
            critical-threshold = 80;
            format = "<big>{icon}</big>";
            format-alt = "<big>{icon}</big> <small>{temperatureC}°C</small>";
            format-critical = " <small>{temperatureC}°C</small>";
            format-icons = [
              ""
              ""
              ""
              ""
              ""
            ];
            tooltip-format = " CPU {temperatureC}°C";
          };
          battery = {
            states = {
              warning = 20;
              critical = 10;
            };
            format = "<big>{icon}</big>";
            format-alt = "<big>{icon}</big> <small>{capacity}%</small>";
            format-charging = "";
            format-full = "󰁹";
            format-plugged = "";
            format-icons = [
              "󰂃"
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
            tooltip-format = "󰁹 {time} ({capacity}%)";
          };
          "custom/session" = {
            format = "<big>⚛️</big>";
            on-click = "${lib.getExe sessionMenu}";
            tooltip-format = " Session Menu";
          };
        }
      ];
    };
  };
}
