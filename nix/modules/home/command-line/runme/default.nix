{ lib, pkgs, ... }:
{
  home.packages = with pkgs; [ runme ];
  programs.fish.interactiveShellInit = lib.rawkOS.fileAsSeparatedString ./init.fish;
}
