{ pkgs, ... }:
{
  home.packages = (
    with pkgs;
    [
      tldr
      unzip
      vim
    ]
  );

  programs.fzf.enable = true;
  programs.skim.enable = true;
}
