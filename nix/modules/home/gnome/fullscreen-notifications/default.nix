{ lib, pkgs, ... }:
with lib;
{
  home.packages = with pkgs.gnomeExtensions; [ fullscreen-notifications ];
}
