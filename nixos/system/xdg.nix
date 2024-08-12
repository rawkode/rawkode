{ pkgs, ... }:
{
  environment.sessionVariables.NIXOS_OZONE_WL = "1";

  environment.systemPackages = with pkgs; [
    slurp
    xdg-desktop-portal
    xdg-desktop-portal-gnome
    xdg-desktop-portal-gtk
  ];

  xdg = {
    mime.enable = true;

    portal = {
      enable = true;

      wlr.enable = true;
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
  };
}
