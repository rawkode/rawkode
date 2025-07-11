{ pkgs, ... }:
{
  programs.vscode = {
    enable = true;
    package = pkgs.vscode;
  };

  catppuccin.vscode.profiles.default.enable = false;
}
