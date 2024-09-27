{ pkgs, ... }:
{
  home.packages = with pkgs; [
    micro
  ];
}
