{
  pkgs,
  ...
}:
{
  programs.niri.enable = true;

  environment.systemPackages = with pkgs; [
    xwayland-satellite

    # Clipboard management
    clipcat
    wl-clipboard
    cliphist

    # Screen management
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

    # Dark/light mode switcher
    darkman

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
