{ pkgs, ... }:
{
  home.packages = [ pkgs.slack ];

  xdg.configFile."slack-desktop/wayland.conf".text = ''
    [Context]
    sockets=wayland;
  '';
}
