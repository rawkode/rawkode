{
  description = "home-manager configuration";

  inputs = {
    catppuccin.url = "github:catppuccin/nix";
    flake-parts = {
      url = "github:hercules-ci/flake-parts";
      inputs.nixpkgs-lib.follows = "nixpkgs";
    };
    firefox.url = "github:nix-community/flake-firefox-nightly";
    ghostty = {
      url = "git+ssh://git@github.com/ghostty-org/ghostty";
    };
    ghostty-hm-module.url = "github:clo4/ghostty-hm-module";
    home-manager.url = "github:nix-community/home-manager";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    utils.url = "github:numtide/flake-utils";
  };

  outputs =
    inputs:
    let
      system = "x86_64-linux";
    in
    {
      homeConfigurations.rawkode = inputs.home-manager.lib.homeManagerConfiguration {
        pkgs = import inputs.nixpkgs { inherit system; };

        extraSpecialArgs = {
          inherit inputs;
        };

        modules = [
          inputs.catppuccin.homeManagerModules.catppuccin
          inputs.ghostty-hm-module.homeModules.default
          ./home.nix
        ];
      };
    };
}
