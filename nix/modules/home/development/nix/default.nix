{ pkgs, ... }:
{
  home.packages = with pkgs; [
    nil
    nixfmt-rfc-style
  ];
}
