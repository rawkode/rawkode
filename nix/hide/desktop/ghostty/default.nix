{
  lib,
  inputs,
  pkgs,
  ...
}:
{

  xdg.configFile."ghostty/config".text = ''
    theme = "catppuccin-frappe"

    font-size = 16
    font-family = "Monaspace Neon"

    shell-integration = fish

    command = "${lib.getExe pkgs.zellij}"

    clipboard-read = "allow"
    clipboard-write = allow
    copy-on-select = clipboard
    clipboard-paste-protection = false

    background-opacity = 0.95
    background-blur-radius = 20

    gtk-single-instance = true
    gtk-titlebar = false

    window-decoration = true
    window-colorspace = display-p3
    window-theme = "dark"
    window-vsync = true
    window-padding-x = 8
    window-padding-y = 8
    window-padding-balance = true
    window-save-state = always

    confirm-close-surface = false;
  '';
}
