{ pkgs, ... }:
{
  imports = [
    ./darkman.nix
    ./electron.nix
    ./fuzzel.nix
    ./hyprland/default.nix
    ./niri.nix
    ./screensharing.nix
    ./spotify.nix
    ./swaync
    ./vivaldi.nix
    ./waybar
    ./wezterm/default.nix
    ./web.nix
  ];

  services.gnome-keyring = {
    enable = true;
  };
}
