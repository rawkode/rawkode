{
  config,
  inputs,
  pkgs,
  ...
}:
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
    flavor = "macchiato";
    accent = "lavender";
    pointerCursor.enable = true;
  };

  home.packages = (
    with pkgs;
    [
      inputs.dagger.packages.${system}.dagger

      aichat
      fzf
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
