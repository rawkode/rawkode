{
  lib,
  config,
  pkgs,
  ...
}:
with lib;
let
  cfg = config.rawkOS.desktop.hyprland;
in
{
  options.rawkOS.desktop.hyprland = {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = "Whether to enable the Hyprland compositor.";
    };

    package = mkOption {
      type = types.package;
      default = pkgs.hyprland;
      description = "The Hyprland package to use.";
    };
  };

  config = mkIf cfg.enable {
    nix.settings = {
      substituters = [ "https://hyprland.cachix.org" ];
      trusted-public-keys = [ "hyprland.cachix.org-1:a7pgxzMz7+chwVL3/pzj6jIBMioiJM7ypFP8PwtkuGc=" ];
    };

    programs.hyprland.enable = true;

    services.gnome.gnome-keyring = {
      enable = true;
    };

    xdg.portal = {
      extraPortals = with pkgs; [
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
      };
    };
  };
}
