{
  config,
  lib,
  pkgs,
  ...
}:
with lib;
let
  cfg = config.rawkOS.desktop.gnome;
in
{
  options.rawkOS.desktop.gnome = {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = "Whether to enable the GNOME";
    };

    paperwm = mkOption {
      type = types.bool;
      default = false;
    };
  };

  config = mkIf cfg.enable {
    services = {
      xserver.desktopManager.gnome.enable = true;
    };
    environment.gnome.excludePackages = with pkgs; [
      baobab
      epiphany
      evince
      geary
      gnome-backgrounds
      gnome-calculator
      gnome-calendar
      gnome-characters
      gnome-connections
      gnome-console
      gnome-contacts
      gnome-disk-utility
      gnome-logs
      gnome-maps
      gnome-music
      gnome-system-monitor
      gnome-text-editor
      gnome-tour
      gnome-user-docs
      orca
      simple-scan
      snapshot
      totem
      yelp
    ];
  };
}
