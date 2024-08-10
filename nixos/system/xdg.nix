{ pkgs, ... }:
{
  xdg.portal = {
    enable = true;

    xdgOpenUsePortal = true;

    config.common.default = "*";

    configPackages = with pkgs; [
      xdg-desktop-portal-gnome
      xdg-desktop-portal-gtk
      xdg-desktop-portal
    ];

    extraPortals = with pkgs; [
      xdg-desktop-portal
      xdg-desktop-portal-gnome
    ];
  };
}
