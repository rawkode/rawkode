{
  lib,
  inputs,
  pkgs,
  ...
}:
{
  home.packages = [ inputs.ghostty.packages.${pkgs.system}.default ];

  xdg.configFile."ghostty/config".text = ''
    theme = "catppuccin-mocha"

    font-size = 16
    font-family = "MonaspiceAr Nerd Font"

    shell-integration = fish

    cursor-style = bar
    mouse-hide-while-typing = true

    clipboard-read = "allow"
    clipboard-write = allow
    copy-on-select = clipboard
    clipboard-trim-trailing-spaces = true
    clipboard-paste-protection = false

    background-opacity = 0.95

    gtk-single-instance = true
    gtk-titlebar = true

    window-decoration = true
    window-colorspace = display-p3
    window-theme = "auto"
    window-vsync = true

    window-padding-x = 8
    window-padding-y = 8
    window-padding-balance = true
    window-save-state = always

    confirm-close-surface = false

    ## Splits
    keybind = alt+r=new_split:right
    keybind = alt+d=new_split:down

    keybind = alt+up=goto_split:top
    keybind = alt+down=goto_split:bottom

    keybind = alt+left=goto_split:left
    keybind = alt+right=goto_split:right
  '';
}
