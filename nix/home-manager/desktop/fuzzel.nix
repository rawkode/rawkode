{ lib, pkgs, ... }:
let
  sessionMenu = pkgs.writeShellApplication {
    name = "session-menu";
    runtimeInputs = with pkgs; [
      fuzzel
      notify-desktop
    ];
    text = ''
      lock="🔒️ Lock"
      logout="👋 Log Out"
      reboot="♻️ Reboot"
      shutdown="🔘 Power Off"

      selected=$(
        echo -e "$lock\n$logout\n$reboot\n$shutdown" |
        fuzzel --dmenu --prompt "⚙️ Session:" --lines 4)
      case $selected in
        "$lock")
          hyprlock --immediate;;
        "$logout")
          hyprctl dispatch exit;;
        "$reboot")
          systemctl reboot;;
        "$shutdown")
          systemctl poweroff;;
      esac
    '';
  };
in
{
  home = {
    packages = with pkgs; [
      bemoji
      wl-clipboard-rs
    ];

    sessionVariables = {
      BEMOJI_PICKER_CMD = "${lib.getExe pkgs.fuzzel} --dmenu";
    };
  };

  programs.fuzzel = {
    enable = true;
    catppuccin.enable = true;
  };

  services = {
    cliphist = {
      enable = true;
      systemdTarget = "hyprland-session.target";
    };
  };

  wayland.windowManager.hyprland = {
    settings = {
      bind = [
        "$mainMod, SPACE, exec, ${lib.getExe pkgs.fuzzel} --prompt '📦 Actions & Applications:' --show-actions"

        "$mainMod shift, Escape, exec, ${lib.getExe sessionMenu}"

        "$mainMod, C, exec, cliphist list | ${lib.getExe pkgs.fuzzel} --dmenu --prompt '📋️ Clipboard:' | cliphist decode | wl-copy --primary --regular --trim-newline"

        "$mainMod, E, exec, ${lib.getExe pkgs.bemoji} --download all --noline --type --clip --hist-limit 32"
      ];
    };
  };
}
