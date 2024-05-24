{ pkgs, ... }:

{
  imports = [
    ./desktop.nix
    ./development.nix
    ./shell.nix
    ./web.nix
  ];

  nixpkgs.config.allowUnfree = true;

  programs.home-manager = {
    enable = true;
  };

  home.packages = (
    with pkgs;
    [
      nil
      nixfmt-rfc-style
      zplug
    ]
  );

  home.username = "rawkode";
  home.homeDirectory = "/home/rawkode";
  home.stateVersion = "23.11";
}
