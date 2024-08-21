{ pkgs, ... }:
{
  programs.hyprland = {
    enable = true;
    package = pkgs.stable.hyprland;
  };

  xdg.portal = {
    enable = true;

    xdgOpenUsePortal = true;

    config = {
      common = {
        default = [ "hyprland" ];
      };
      hyprland = {
        default = [
          "gtk"
          "hyprland"
        ];
      };
    };

    extraPortals = with pkgs; [ xdg-desktop-portal-gtk ];

  };

  security = {
    pam.services = {
      hyprlock = { };
      gdm.enableGnomeKeyring = true;
      gdm-password.enableGnomeKeyring = true;
    };
    polkit.enable = true;
  };

  services = {
    gvfs.enable = true;
    devmon.enable = true;
    udisks2.enable = true;
    upower.enable = true;
    power-profiles-daemon.enable = true;
    accounts-daemon.enable = true;

    gnome = {
      evolution-data-server.enable = true;
      glib-networking.enable = true;
      gnome-keyring.enable = true;
      gnome-online-accounts.enable = true;
      tracker-miners.enable = true;
      tracker.enable = true;
    };

    xserver = {
      enable = true;
      displayManager.gdm.enable = true;
      displayManager.gdm.wayland = true;
    };

    displayManager = {
      defaultSession = "hyprland";
    };

    xserver.xkb.layout = "us";
  };

  environment.systemPackages = with pkgs; [
    brightnessctl
    gnome-calculator
    gnome-calendar
    gnome-system-monitor
    gnome.gnome-boxes
    gnome.gnome-clocks
    gnome.gnome-control-center
    gnome.gnome-software
    gnome.gnome-weather
    loupe
    nautilus
    wl-clipboard
    wl-gammactl
  ];

}
