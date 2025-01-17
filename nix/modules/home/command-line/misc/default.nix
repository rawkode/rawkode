{ pkgs, ... }:
{
  home.packages = (
    with pkgs;
    [
      ripgrep
      tldr
      unzip
      vim
    ]
  );

  programs.fzf.enable = true;
  programs.skim.enable = true;

  programs.direnv = {
    enable = true;
    nix-direnv.enable = true;
  };
}
