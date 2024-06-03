{ pkgs, ... }:

{
  imports = [
    ./desktop.nix
    ./development.nix
    ./niri.nix
    ./shell.nix
    ./web.nix
    ./wezterm.nix
  ];

  nixpkgs.config.allowUnfree = true;

  programs.home-manager = {
    enable = true;
  };

  catppuccin = {
    flavor = "frappe";
    enable = true;
  };

  programs.foot = {
    enable = true;
    settings = {
      main = {
        shell = "${pkgs.zellij}/bin/zellij";
        term = "xterm-256color";
        font = "Monaspace Neon:size=16";
        dpi-aware = true;
      };
    };
  };

  programs.ssh = {
    enable = true;
    extraConfig = ''
      IdentityAgent ~/.1password/agent.sock
    '';
  };

  programs.fish = {
    interactiveShellInit = ''
      op completion fish | source
    '';
  };

  home.packages = (
    with pkgs;
    [
      nil
      nixfmt-rfc-style
    ]
  );

  home.username = "rawkode";
  home.homeDirectory = "/home/rawkode";
  home.stateVersion = "23.11";
}
