{ pkgs, ... }:
{
  home.packages = with pkgs; [ runme ];
}
