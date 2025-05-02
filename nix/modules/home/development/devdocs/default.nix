{ pkgs, ... }:
{
  home.packages = with pkgs; [ devdocs-desktop ];
}
