{ pkgs, ... }:
{
  services = {
    xserver.xkb.layout = "us";
    xserver = {
      enable = true;
      displayManager.gdm.enable = true;
      displayManager.gdm.wayland = true;
    };
  };

  xdg = {
    portal = {
      enable = true;
      xdgOpenUsePortal = true;

      extraPortals = with pkgs; [
        xdg-desktop-portal-gtk
        xdg-desktop-portal-gnome
        xdg-desktop-portal-wlr
      ];

      wlr = {
        enable = true;
        settings.screencast = {
          max_fps = 60;
        };
      };
    };
  };
}
