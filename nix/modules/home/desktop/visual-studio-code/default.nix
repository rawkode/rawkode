{ pkgs, ... }:
{
  programs.vscode = {
    enable = true;
    package = pkgs.vscode-fhs;
  };

  catppuccin.vscode.profiles.default.enable = false;
}
