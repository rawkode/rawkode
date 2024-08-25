{
  lib,
  config,
  pkgs,
  ...
}:
with lib;
with lib.rawkOS;
let
  cfg = config.rawkOS.desktop.niri;
in
{
  options.rawkOS.desktop.niri = {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = "Whether to enable the Niri compositor.";
    };

    package = mkOption {
      type = types.package;
      default = pkgs.niri;
      description = "The Niri package to use.";
    };
  };

  config = mkIf cfg.enable {
    programs.niri.enable = true;

    hardware.opengl.package = pkgs.unstable.mesa.drivers;

    services.gnome.gnome-keyring = {
      enable = true;
    };

    xdg.portal = {
      extraPortals = with pkgs; [
        xdg-desktop-portal-gtk
        xdg-desktop-portal-gnome
        xdg-desktop-portal-wlr
      ];

      config = {
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
