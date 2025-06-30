{ pkgs, ... }:
{
  home.packages = with pkgs; [ moon ];
}
