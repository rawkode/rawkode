{ pkgs, ... }:
{
  home.username = "rawkode";
  home.homeDirectory = "/home/rawkode";
  home.stateVersion = "23.11";

  nixpkgs.config.allowUnfree = true;

  programs.home-manager = {
    enable = true;
  };

  catppuccin = {
    flavor = "frappe";
    enable = true;
  };

  home.packages = (
    with pkgs;
    [
      fishPlugins.github-copilot-cli-fish
      morgen
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
