{ lib, pkgs, ... }:
with lib;
{
  programs.gnome-shell.extensions = with pkgs.gnomeExtensions; [
    {
      package = blur-my-shell;
    }
  ];
}
