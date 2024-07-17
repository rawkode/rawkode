{ pkgs, ... }:
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
    environmentVariables = {
			SSH_AUTH_SOCK = "\${SSH_AUTH_SOCK:$HOME/.1password/agent.sock}";
    };
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
