{ pkgs, ... }:
{
  environment.systemPackages = with pkgs; [
    xdg-desktop-portal-gnome
    xdg-desktop-portal-gtk
  ];

  xdg.portal = {
    enable = true;

    xdgOpenUsePortal = true;

    config = {
      common = {
        default = [ "gtk" ];
        "org.freedesktop.impl.portal.Secret" = [ "gnome-keyring" ];
      };
    };

    extraPortals = with pkgs; [
      xdg-desktop-portal-gnome
    ];
  };
}
