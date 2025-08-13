{ pkgs, ... }:
{
  home.packages = with pkgs; [ bun ];
  home.sessionPath = [
    "/home/rawkode/.bun/bin"
  ];
}
