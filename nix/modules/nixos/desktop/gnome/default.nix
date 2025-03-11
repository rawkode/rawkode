{
  lib,
  pkgs,
  ...
}:
{
  services = {
    xserver = {
      enable = true;

      displayManager.gdm = {
        enable = lib.mkDefault true;
        wayland = true;
      };

      desktopManager.gnome.enable = lib.mkDefault true;
    };
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
}
