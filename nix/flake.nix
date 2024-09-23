{
  description = "rawkOS: Rawkode's Nix Configured Operating System";

  inputs = {
    stable.url = "github:nixos/nixpkgs/nixos-24.05";
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

    auto-cpufreq = {
      url = "github:AdnanHodzic/auto-cpufreq";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    browser-previews = {
      url = "github:nix-community/browser-previews";
      inputs.nixpkgs.follows = "nixpkgs";
    };
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
      url = "github:nix-community/home-manager/master";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    impermanence.url = "github:nix-community/impermanence";
    lanzaboote = {
      url = "github:nix-community/lanzaboote";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    ghostty.url = "git+ssh://git@github.com/ghostty-org/ghostty";
    nix-colors.url = "github:misterio77/nix-colors";
    nix-index-database = {
      url = "github:nix-community/nix-index-database";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixos-hardware.url = "github:NixOS/nixos-hardware/master";
    snowfall-lib = {
      url = "github:snowfallorg/lib";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    # 24.05
    stylix.url = "github:danth/stylix?ref=e59d2c1725b237c362e4a62f5722f5b268d566c7";
    wezterm.url = "github:wez/wezterm?dir=nix";
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

      specialArgs = with inputs; {
        inherit nix-colors;
      };

      homes.modules = with inputs; [
        catppuccin.homeManagerModules.catppuccin
        flatpaks.homeManagerModules.nix-flatpak
        nix-index-database.hmModules.nix-index
      ];

      systems.modules.nixos = with inputs; [
        auto-cpufreq.nixosModules.default
        catppuccin.nixosModules.catppuccin
        cosmic.nixosModules.default
        flatpaks.nixosModules.nix-flatpak
        impermanence.nixosModules.impermanence
        lanzaboote.nixosModules.lanzaboote
        (
          { ... }:
          {
            nix.registry.nixpkgs.flake = nixpkgs;
            nix.registry.stable.flake = stable;
            nix.registry.rawkode.flake = self;
            nix.registry.templates.flake = self;
          }
        )
      ];
    };
}
