{
  lib,
  inputs,
  pkgs,
  ...
}:
{
  home.packages = [ inputs.ghostty.packages.${pkgs.system}.default ];

  xdg.configFile."ghostty/config".text = ''
    theme = "catppuccin-frappe"

    font-size = 24
    font-family = "Monaspace Argon"

    shell-integration = fish

    cursor-style = bar;
    mouse-hide-while-typing = true

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
