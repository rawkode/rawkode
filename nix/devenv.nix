{ pkgs, ... }:
{
  languages.nix.enable = true;

  packages = with pkgs; [ runme ];
}
