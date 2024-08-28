{ pkgs, ... }:
{
  # Installing these via system instead of Flatpak,
  # because when it's installed as a Flatpak it can
  # only route to other Flatpak applications.
  home.packages = with pkgs; [ gnomeExtensions.bowser-gnome-extension junction ];
}
