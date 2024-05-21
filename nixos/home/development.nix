{ config, pkgs, ... }:

{
  imports =
    [
      ./development/containers.nix
      ./development/git.nix
      ./development/vscode.nix
    ];

  home.packages = (with pkgs; [
    rustup
    wezterm
    zed-editor
    zellij
  ]);
}
