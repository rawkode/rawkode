{ pkgs, ... }:
{
  home.packages = with pkgs; [ bun ];

  home.sessionPath = [
    "~/.bun/bin"
  ];
}
