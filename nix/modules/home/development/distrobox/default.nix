{ pkgs, ... }:
{
  home.packages = with pkgs; [
    boxbuddy
    distrobox
    toolbox
  ];
}
