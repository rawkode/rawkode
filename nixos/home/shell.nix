{ config, pkgs, ... }:

{
  home.file.".zshrc".source = ./shell/zsh/zshrc.zsh;
  home.file.".zsh/aliases.zsh".source = ./shell/zsh/aliases.zsh;
  home.file.".zsh/common.zsh".source = ./shell/zsh/common.zsh;
  home.file.".zsh/history.zsh".source = ./shell/zsh/history.zsh;
  home.file.".zsh/keybindings.zsh".source = ./shell/zsh/keybindings.zsh;
  home.file.".zsh/paths.zsh".source = ./shell/zsh/paths.zsh;
  home.file.".zsh/powerlevel9k.zsh".source = ./shell/zsh/powerlevel9k.zsh;
  home.file.".zsh/zplug.zsh".source = ./shell/zsh/zplug.zsh;

  home.file.".config/fish/config.fish".source = ./shell/fish/config.fish;
  home.file.".config/fish/fishfile".source = ./shell/fish/fishfile;

  home.packages = (with pkgs; [
    bat
    direnv
    eza
    fzf
    ripgrep
    tldr
    unzip
    vim
    wget
    zsh
  ]);

  programs.direnv.enable = true;
  programs.ssh.enable = true;
}
