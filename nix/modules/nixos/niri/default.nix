{ pkgs, ... }:
{
  imports = [ ./portal.nix ];

  programs.niri = {
    enable = true;
  };

  environment.systemPackages = with pkgs; [
    xwayland-satellite

    # Clipboard management
    clipcat
    wl-clipboard
    cliphist

    # Screen management
    hyprlock
    hyprcursor
    hypridle
    swayidle
    swaylock
    brightnessctl

    # Notification daemon
    swaynotificationcenter

    # Wallpaper
    swww

    # App launcher
    fuzzel
    bemoji

    # Authentication agent
    polkit_gnome

    # Screenshot utilities
    grim
    slurp

    # Other utilities
    blueman
    pavucontrol
  ];
}
