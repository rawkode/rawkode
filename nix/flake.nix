{
  description = "rawkOS: Rawkode's Nix Configured Operating System";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-24.05";
    unstable.url = "github:nixos/nixpkgs/nixos-unstable";

    # Using this for deno 2
    master.url = "github:nixos/nixpkgs/master";

    # This can be removed when this is merged.
    # https://github.com/NixOS/nixpkgs/pull/344700
    evdi.url = "github:nixos/nixpkgs/b6d57c6bf0238f386ab6170e118b610c7d542f9c";

    auto-cpufreq = {
      url = "github:AdnanHodzic/auto-cpufreq";
      inputs.nixpkgs.follows = "unstable";
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
    disko = {
      url = "github:nix-community/disko";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    firefox.url = "github:nix-community/flake-firefox-nightly";
    flatpaks.url = "github:gmodena/nix-flatpak/?ref=v0.4.1";
    home-manager = {
      url = "github:nix-community/home-manager/release-24.05";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    ghostty.url = "git+ssh://git@github.com/ghostty-org/ghostty";
    lanzaboote = {
      url = "github:nix-community/lanzaboote";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nix-index-database = {
      url = "github:nix-community/nix-index-database";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixos-hardware.url = "github:NixOS/nixos-hardware/master";
    snowfall-lib = {
      url = "github:snowfallorg/lib";
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
        disko.nixosModules.disko
        flatpaks.nixosModules.nix-flatpak
        lanzaboote.nixosModules.lanzaboote
        (
          { ... }:
          {
            nix.registry.nixpkgs.flake = nixpkgs;
            nix.registry.unstable.flake = unstable;
            nix.registry.rawkode.flake = self;
            nix.registry.templates.flake = self;
          }
        )
      ];
    };
}
