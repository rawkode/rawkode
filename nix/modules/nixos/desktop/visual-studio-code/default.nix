{ pkgs, ... }:
{
  system.environmentPackages = with pkgs; [
    vscode
  ];
}
