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

  programs.nushell = {
    enable = true;

		shellAliases = {
			ai = "op run --account my.1password.eu -- aichat";
		};

    environmentVariables = {
      GEMINI_API_KEY = ''"op://Private/Google Gemini/password"'';
			NIX_LINK = ''"/nix/var/nix/profiles/default"'';
			NIX_PROFILES = "/nix/var/nix/profiles/default ($env.NIX_LINK)";
			PATH = ''"($env.PATH | split row (char esep) | prepend $'($env.HOME)/.nix-profile/bin)' | append $'($env.NIX_LINK)/bin')"'';
      SSH_AUTH_SOCK = ''"($env.HOME | path join '1password' 'agent.sock')"'';
    };
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
      fzf
			monaspace
      nil
      nixfmt-rfc-style
    ]
  );
}
