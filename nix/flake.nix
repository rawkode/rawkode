{
  description = "rawkOS: Rawkode's Nix Configured Operating System";

  outputs =
    { self, nixpkgs, ... }@inputs:
    let
      inherit (self) outputs;
      username = "rawkode";
      stateVersion = "24.05";
      helper = import ./lib {
        inherit
          inputs
          outputs
          stateVersion
          username
          ;
      };
    in
    {
      overlays = import ./overlays { inherit inputs; };

      nixosConfigurations = {
        "desktop" = helper.mkNixos {
          hostname = "desktop";
          desktop = "hyprland";
        };
      };

      homeConfigurations = {
        "desktop" = helper.mkHome {
          hostname = "desktop";
          platform = "x86_64-linux";
          desktop = "hyprland";
        };
      };
    };

  inputs = {
    anyrun = {
      url = "github:Kirottu/anyrun";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    catppuccin.url = "github:catppuccin/nix";
    dagger = {
      url = "github:dagger/nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    flatpaks.url = "github:GermanBread/declarative-flatpak/stable";
    firefox.url = "github:nix-community/flake-firefox-nightly";
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    hyprland.url = "github:hyprwm/Hyprland";
    lanzaboote.url = "github:nix-community/lanzaboote";
    nixos-hardware.url = "github:NixOS/nixos-hardware/master";
    nixpkgs-stable.url = "github:nixos/nixpkgs/release-24.05";
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    plasma-manager = {
      url = "github:nix-community/plasma-manager";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.home-manager.follows = "home-manager";
    };
    wezterm = {
      url = "github:wez/wezterm?dir=nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };
}
