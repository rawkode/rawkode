{ pkgs, ... }:
{
  imports = [
    ./hyprland.nix
    ./niri.nix
  ];

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

      config = {
        hyprland = {
          default = "gnome;gtk";
          "org.freedesktop.impl.portal.ScreenCast" = "wlr";
          "org.freedesktop.impl.portal.FileChooser" = [ "gtk" ];
          "org.freedesktop.impl.portal.Secret" = [ "gnome-keyring" ];
          "org.freedesktop.impl.portal.Screenshot" = "wlr";
        };
        niri-session = {
          default = "gnome;gtk";
          "org.freedesktop.impl.portal.ScreenCast" = "wlr";
          "org.freedesktop.impl.portal.FileChooser" = [ "gtk" ];
          "org.freedesktop.impl.portal.Secret" = [ "gnome-keyring" ];
          "org.freedesktop.impl.portal.Screenshot" = "wlr";
        };
      };
    };
  };
}
