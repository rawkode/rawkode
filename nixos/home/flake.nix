{
  description = "home-manager configuration";

  inputs = {
    catppuccin.url = "github:catppuccin/nix";
    home-manager.url = "github:nix-community/home-manager";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, home-manager, nixpkgs, utils, catppuccin }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      homeConfigurations.rawkode = home-manager.lib.homeManagerConfiguration {
        inherit pkgs;
        modules = [
          catppuccin.homeManagerModules.catppuccin
          ./home.nix
        ];
      };
    };
}
