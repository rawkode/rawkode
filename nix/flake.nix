{
  description = "rawkOS: Rawkode's Nix Configured Operating System";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-24.05";
    unstable.url = "github:nixos/nixpkgs/nixos-unstable";

    catppuccin.url = "github:catppuccin/nix";
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
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    hyprland.url = "github:hyprwm/Hyprland";
    impermanence.url = "github:nix-community/impermanence";
    lanzaboote.url = "github:nix-community/lanzaboote";
    niri.url = "github:sodiboo/niri-flake";
    nixos-hardware.url = "github:NixOS/nixos-hardware/master";
    snowfall-lib = {
      url = "github:snowfallorg/lib";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    stylix.url = "github:danth/stylix";
    wezterm = {
      url = "github:wez/wezterm?dir=nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
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

      systems.modules.nixos = with inputs; [
        catppuccin.nixosModules.catppuccin
        cosmic.nixosModules.default
        home-manager.nixosModules.default
        impermanence.nixosModules.impermanence
        lanzaboote.nixosModules.lanzaboote
        niri.nixosModules.niri

        (
          { ... }:
          {
            nix.registry.nixpkgs.flake = nixpkgs;
            nix.registry.unstable.flake = unstable;
            nix.registry.rawkode.flake = self;
            nix.registry.templates.flake = self;

            nix.settings = {
              auto-optimise-store = true;
              substituters = [ "https://cache.nixos.org" ];
              trusted-public-keys = [ "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=" ];
            };
          }
        )
      ];
    };
}
