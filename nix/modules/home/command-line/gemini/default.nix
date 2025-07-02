{ pkgs, ... }:
{
  home.packages = with pkgs; [
    gemini-cli
  ];
}
