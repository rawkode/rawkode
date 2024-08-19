{
  programs.vivaldi.enable = true;

  wayland.windowManager.hyprland.extraConfig = ''
    windowrulev2=workspace 1, class:^(vivaldi-stable)$
  '';
}
