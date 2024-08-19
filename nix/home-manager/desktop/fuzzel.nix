{ lib, pkgs, ... }:
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
        "$mainMod, SPACE, exec, ${lib.getExe pkgs.fuzzel} --prompt '🚀 Desktop Actions > ' --show-actions"
        "$mainMod, C, exec, cliphist list | ${lib.getExe pkgs.fuzzel} --dmenu --prompt '📋️ Clipboard > ' | cliphist decode | wl-copy --primary --regular --trim-newline"
        "$mainMod, E, exec, ${lib.getExe pkgs.bemoji} --clip --noline --type --hist-limit 32"
        "$mainMod, R, exec, history | uniq | ${lib.getExe pkgs.fuzzel} --dmenu --prompt '💲 Command History > ' | wl-copy --primary --regular --trim-newline"
      ];
    };
  };
}
