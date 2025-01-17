{ lib, pkgs, ... }:
{
  home.packages = with pkgs; [ runme ];

  programs.fish.interactiveShellInit = ''
    ${lib.getExe pkgs.runme} completion fish | source
  '';
}
