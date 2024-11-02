{ pkgs, ... }: {
  home.packages = (with pkgs; [ eza ripgrep tldr unzip vim ]);

  programs.bat.enable = true;
  programs.fzf.enable = true;
  programs.skim.enable = true;

  programs.direnv = {
    enable = true;
    nix-direnv.enable = true;
  };
}
