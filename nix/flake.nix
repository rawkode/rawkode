{
  description = "rawkOS: Rawkode's Nix Configured Operating System";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-25.05";
    unstable.url = "github:nixos/nixpkgs/nixos-unstable";
    master.url = "github:nixos/nixpkgs/master";
    moon.url = "git+https://github.com/NixOs/nixpkgs?rev=78fcdda7edf3195d3840c01c17890797228f2441";

    auto-cpufreq = {
      url = "github:AdnanHodzic/auto-cpufreq";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    browser-previews = {
      url = "github:nix-community/browser-previews";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    catppuccin.url = "github:catppuccin/nix";
    codex.url = "github:openai/codex";
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
    niri = {
      url = "github:sodiboo/niri-flake";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    snowfall-lib = {
      url = "github:snowfallorg/lib";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    treefmt-nix.url = "github:numtide/treefmt-nix";
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

      # Eval the treefmt modules from ./treefmt.nix
      treefmtEval = inputs.nixpkgs.lib.genAttrs [ "x86_64-linux" ] (
        system: inputs.treefmt-nix.lib.evalModule inputs.nixpkgs.legacyPackages.${system} ./treefmt.nix
      );
    in
    lib.mkFlake {
      channels-config = {
        allowUnfree = true;
        joypixels.acceptLicense = true;
      };

      specialArgs = with inputs; {
        inherit nix-colors;
      };

      homes.modules = with inputs; [
        catppuccin.homeModules.catppuccin
        flatpaks.homeManagerModules.nix-flatpak
        nix-index-database.hmModules.nix-index
        niri.homeModules.niri
      ];

      systems.modules.nixos = with inputs; [
        {
          nix.settings = {
            substituters = [
              "https://cosmic.cachix.org/"
              "https://niri.cachix.org"
              "https://wezterm.cachix.org"
            ];
            trusted-public-keys = [
              "cosmic.cachix.org-1:Dya9IyXD4xdBehWjrkPv6rtxpmMdRel02smYzA85dPE="
              "niri.cachix.org-1:Wv0OmO7PsuocRKzfDoJ3mulSl7Z6oezYhGhR+3W2964="
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

      outputs-builder = channels: {
        # for `nix fmt`
        formatter = treefmtEval.${channels.nixpkgs.system}.config.build.wrapper;

        # for `nix flake check`
        checks.formatting = treefmtEval.${channels.nixpkgs.system}.config.build.check inputs.self;
      };
    };
}
