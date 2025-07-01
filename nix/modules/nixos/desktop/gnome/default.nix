{ lib
, pkgs
, ...
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

    # Disable file search, never used it once
    # and it consumes more resources than I'd like
    gnome = {
      localsearch.enable = lib.mkForce false;
      tinysparql.enable = lib.mkForce false;
    };
  };

  qt = {
    enable = true;
    platformTheme = "gnome";
    style = "adwaita-dark";
  };

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
