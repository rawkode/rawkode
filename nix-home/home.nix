{ config, pkgs, ... }:
{
  home.username = "rawkode";
  home.homeDirectory = "/home/rawkode";
  home.stateVersion = "23.11";

  imports = [
    ./command-line/default.nix
    ./desktop/default.nix
    ./development/default.nix
  ];

  nixpkgs.config.allowUnfree = true;

  programs.home-manager = {
    enable = true;
  };

  home.file."${config.xdg.configHome}/aichat/config.yaml" = {
		source = ./programs/aichat/config.yaml;
  };

  catppuccin = {
    enable = true;
    flavor = "frappe";
    accent = "blue";
    pointerCursor.enable = true;
  };

  home.packages = (
    with pkgs;
    [
      aichat
      discord
      slack
      fzf
      nil
      nixfmt-rfc-style
      rquickshare
			zoxide
    ]
  );
}
