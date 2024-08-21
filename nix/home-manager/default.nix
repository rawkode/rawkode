{
  config,
  inputs,
  outputs,
  pkgs,
  ...
}:
{
  home.username = "rawkode";
  home.homeDirectory = "/home/rawkode";
  home.stateVersion = "23.11";

  imports = [
    inputs.catppuccin.homeManagerModules.catppuccin
    inputs.flatpaks.homeManagerModules.nix-flatpak

    ./command-line/default.nix
    ./desktop/default.nix
    ./development/default.nix
    ./flatpak.nix
  ];

  nixpkgs.config.allowUnfree = true;

  nixpkgs = {
    overlays = [
      outputs.overlays.modifications
      outputs.overlays.stable-packages
    ];
  };

  programs.home-manager = {
    enable = true;
  };

  home.file."${config.xdg.configHome}/aichat/config.yaml" = {
    source = ./programs/aichat/config.yaml;
  };

  catppuccin = {
    enable = true;
    flavor = "mocha";
    accent = "mauve";
    pointerCursor.enable = true;
  };

  home.packages = (
    with pkgs;
    [
      inputs.dagger.packages.${system}.dagger

      aichat
      fzf
      just
      nil
      nixfmt-rfc-style
      rquickshare
      slack
      vesktop
      zoom-us
      zoxide
    ]
  );
}
