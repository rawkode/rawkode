{
  description = "rawkOS: Rawkode's Nix Configured Operating System";

  inputs = {
    nixpkgs = {
      url = "github:nixos/nixpkgs/nixos-25.05";
    };
		unstable = {
      url = "github:nixos/nixpkgs/nixos-unstable";
    };
		moon = {
			url = "git+https://github.com/NixOS/nixpkgs?rev=78fcdda7edf3195d3840c01c17890797228f2441";
		};

    auto-cpufreq = {
      url = "github:AdnanHodzic/auto-cpufreq";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    catppuccin.url = "github:catppuccin/nix";
    comma = {
      url = "github:nix-community/comma";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    cosmic.url = "github:lilyinstarlight/nixos-cosmic";
    dagger = {
      url = "github:dagger/nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    disko = {
      url = "github:nix-community/disko";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    firefox.url = "github:nix-community/flake-firefox-nightly";
    flatpaks.url = "github:gmodena/nix-flatpak";
    home-manager = {
      url = "github:nix-community/home-manager/release-25.05";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    lanzaboote = {
      url = "github:nix-community/lanzaboote";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixos-facter-modules.url = "github:numtide/nixos-facter-modules";
    nix-index-database = {
      url = "github:nix-community/nix-index-database";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixos-hardware.url = "github:NixOS/nixos-hardware/master";
    snowfall-lib = {
      url = "github:snowfallorg/lib";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    wezterm.url = "github:wez/wezterm/bc3dde9e75b7f656f32a996378ec6048df2bfda4?dir=nix";
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
        catppuccin.homeModules.catppuccin
        flatpaks.homeManagerModules.nix-flatpak
        nix-index-database.hmModules.nix-index
      ];

      systems.modules.nixos = with inputs; [
        {
          nix.settings = {
            substituters = [
              "https://cosmic.cachix.org/"
              "https://wezterm.cachix.org"
            ];
            trusted-public-keys = [
              "cosmic.cachix.org-1:Dya9IyXD4xdBehWjrkPv6rtxpmMdRel02smYzA85dPE="
              "wezterm.cachix.org-1:kAbhjYUC9qvblTE+s7S+kl5XM1zVa4skO+E/1IDWdH0="
            ];
          };
        }

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
            nix.registry.rawkode.flake = self;
            nix.registry.templates.flake = self;
          }
        )
      ];
    };
}
