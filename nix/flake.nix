{
  description = "rawkOS: Rawkode's Nix Configured Operating System";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-24.05";
    unstable.url = "github:nixos/nixpkgs/nixos-unstable";

    catppuccin.url = "github:catppuccin/nix";
    comma = {
      url = "github:nix-community/comma";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    cosmic = {
      url = "github:lilyinstarlight/nixos-cosmic";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    dagger = {
      url = "github:dagger/nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    firefox.url = "github:nix-community/flake-firefox-nightly";
    flatpaks.url = "github:gmodena/nix-flatpak/?ref=v0.4.1";
    home-manager = {
      url = "github:nix-community/home-manager/release-24.05";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    # Pinned to 0.42, which is what Hyprscroller needs for now.
    hyprland = {
      url = "git+https://github.com/hyprwm/Hyprland?rev=9a09eac79b85c846e3a865a9078a3f8ff65a9259&submodules=1";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    hyprscroller = {
      url = "github:dawsers/hyprscroller";
      inputs.hyprland.follows = "hyprland";
    };
    impermanence.url = "github:nix-community/impermanence";
    ironbar = {
      url = "github:JakeStanger/ironbar";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    lanzaboote = {
      url = "github:nix-community/lanzaboote";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    niri.url = "github:sodiboo/niri-flake";
    nix-colors.url = "github:misterio77/nix-colors";
    nix-index-database = {
      url = "github:nix-community/nix-index-database";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixos-hardware.url = "github:NixOS/nixos-hardware/master";
    plasma-manager = {
      url = "github:nix-community/plasma-manager";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.home-manager.follows = "home-manager";
    };
    snowfall-lib = {
      url = "github:snowfallorg/lib";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    # 24.05
    stylix.url = "github:danth/stylix?ref=e59d2c1725b237c362e4a62f5722f5b268d566c7";
  };

  outputs =
    inputs:
    let
      lib = inputs.snowfall-lib.mkLib {
        inherit inputs;

        src = ./.;

        snowfall = {
          namespace = "rawkOS";
          meta = {
            name = "rawkOS";
            title = "rawkOS: Rawkode's Nix Configured Operating System";
          };
        };
      };
    in
    lib.mkFlake {
      channels-config = {
        allowUnfree = true;
      };

      overlays = with inputs; [ niri.overlays.niri ];

      specialArgs = with inputs; {
        inherit nix-colors;
      };

      homes.modules = with inputs; [
        catppuccin.homeManagerModules.catppuccin
        flatpaks.homeManagerModules.nix-flatpak
        ironbar.homeManagerModules.default
        nix-index-database.hmModules.nix-index
        plasma-manager.homeManagerModules.plasma-manager
      ];

      systems.modules.nixos = with inputs; [
        catppuccin.nixosModules.catppuccin
        cosmic.nixosModules.default
        flatpaks.nixosModules.nix-flatpak
        impermanence.nixosModules.impermanence
        lanzaboote.nixosModules.lanzaboote
        niri.nixosModules.niri
        (
          { ... }:
          {
            nix.registry.nixpkgs.flake = nixpkgs;
            nix.registry.rawkode.flake = self;
            nix.registry.unstable.flake = unstable;
            nix.registry.templates.flake = self;

          }
        )
      ];
    };
}
