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
    enable = true;
    flavor = "frappe";
    accent = "blue";
    pointerCursor.enable = true;
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

  services.espanso = {
    enable = true;
    package = pkgs.espanso-wayland;
    matches.default.matches = [
      {
        # Simple text replacement
        trigger = "]espanso";
        replace = "Hi there!";
      }
    ];
  };

  imports = [
    ./command-line/default.nix
    ./desktop/default.nix
    ./development/default.nix
  ];
}
