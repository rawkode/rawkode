{ config, pkgs, ... }:
{
  home.packages = (
    with pkgs;
    [
      bat
      eza
      fzf
      ripgrep
      tldr
      unzip
      vim
    ]
  );

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
