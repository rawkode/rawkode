{
  flake.nixosModules.portals =
    { pkgs, ... }:
    {
      xdg.portal = {
        enable = true;
        config.common = {
          default = [
            "gtk"
          ];
          "org.freedesktop.impl.portal.Secret" = [
            "gnome-keyring"
          ];
        };
        extraPortals = with pkgs; [
          gnome-keyring
          xdg-desktop-portal-gtk
        ];
      };
    };
  flake.homeModules.portals =
    { pkgs, lib, ... }:
    {
      xdg.portal = {
        enable = true;
        xdgOpenUsePortal = true;
        config.common = {
          default = lib.mkDefault [
            "gtk"
          ];
          "org.freedesktop.impl.portal.Secret" = [
            "gnome-keyring"
          ];
        };
        extraPortals = with pkgs; [
          xdg-desktop-portal
          xdg-desktop-portal-gtk
        ];
      };
    };
}
