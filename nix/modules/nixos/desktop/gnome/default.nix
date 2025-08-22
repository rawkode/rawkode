{ lib
, pkgs
, ...
}:
{
  services = {
    displayManager.gdm = {
      enable = lib.mkDefault true;
      wayland = true;
    };

    desktopManager.gnome.enable = lib.mkDefault true;
  };

  qt.enable = true;

  environment.systemPackages = with pkgs; [
    cheese
    gnome-extension-manager
    nautilus-open-any-terminal
  ];

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
