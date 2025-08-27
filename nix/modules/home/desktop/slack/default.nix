{ pkgs, ... }:
{
  # Can't login with Flatpak, uri scheme isn't registered?
  home.packages = with pkgs; [
    slack
  ];
}
