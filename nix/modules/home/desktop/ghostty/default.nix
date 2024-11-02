{ inputs, pkgs, ... }: {
  home.packages = [ inputs.ghostty.packages.${pkgs.system}.default ];

  xdg.configFile."ghostty/config".text = ''
    theme = "catppuccin-mocha"

    font-size = 12
    font-family = "Monaspace Neon"

    shell-integration = fish

    mouse-hide-while-typing = true

    clipboard-read = "allow"
    clipboard-write = allow
    copy-on-select = clipboard
    clipboard-paste-protection = false

    background-opacity = 0.95
    background-blur-radius = 20

    gtk-single-instance = true
    gtk-titlebar = true

    window-decoration = true
    window-colorspace = display-p3
    window-theme = "dark"
    window-vsync = true
    window-padding-x = 8
    window-padding-y = 8
    window-padding-balance = true
    window-save-state = always
  '';
}
