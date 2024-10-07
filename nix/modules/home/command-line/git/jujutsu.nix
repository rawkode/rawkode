{ pkgs, ... }:
{
  home.packages = with pkgs; [ jujutsu ];
}
