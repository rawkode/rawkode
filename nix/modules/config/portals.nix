_:
let
  mkApp = import ../../lib/mkApp.nix;
in
mkApp {
  name = "portals";

  linux.system =
    { pkgs, ... }:
    {
      # The Secret portal is only a front end for org.freedesktop.secrets. The
      # keyring's D-Bus activation file execs /run/wrappers/bin/gnome-keyring-daemon,
      # which exists only when the service is enabled. Enabling it also registers
      # the portal backend and unlocks the login keyring through PAM.
      services.gnome.gnome-keyring.enable = true;
      security.pam.services.greetd.enableGnomeKeyring = true;

      xdg.portal = {
        enable = true;
        xdgOpenUsePortal = true;
        config.common = {
          default = [
            "gtk"
          ];
          "org.freedesktop.impl.portal.Secret" = [
            "gnome-keyring"
          ];
        };
        extraPortals = with pkgs; [
          xdg-desktop-portal-gtk
        ];
      };
    };
}
