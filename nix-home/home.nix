{ config, pkgs, ... }:
{
  home.username = "rawkode";
  home.homeDirectory = "/home/rawkode";
  home.stateVersion = "23.11";

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
      SSH_AUTH_SOCK = "($env.HOME | path join '1password' 'agent.sock')";
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
      fishPlugins.github-copilot-cli-fish
      nil
      nixfmt-rfc-style
    ]
  );

  imports = [
    ./command-line/default.nix
    ./desktop/default.nix
    ./development/default.nix
  ];
}
