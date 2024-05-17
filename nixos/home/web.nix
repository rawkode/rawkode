{ config, pkgs, ... }:

{
  home.packages = (with pkgs; [
    firefox-devedition
    vivaldi
  ]);
}
