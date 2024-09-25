{ config, pkgs, ... }:
{
  home.packages = (
    with pkgs;
    [
      eza
      nixfmt-rfc-style
      ripgrep
      tldr
      unzip
      vim
    ]
  );

  programs.bat.enable = true;
  programs.fzf.enable = true;
  programs.skim.enable = true;

  programs.direnv = {
    enable = true;
    nix-direnv.enable = true;
  };

  programs.ssh = {
    enable = true;
    extraConfig = ''
      IdentityAgent "${config.home.homeDirectory}/.1password/agent.sock"
    '';
  };
}
