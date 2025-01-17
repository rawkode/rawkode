{ lib, pkgs, ... }:
with lib;
{
  home.packages = with pkgs; [ rclone ];

  programs.gnome-shell.extensions = with pkgs.gnomeExtensions; [
    {
      package = rclone-manager;
    }
  ];
}
