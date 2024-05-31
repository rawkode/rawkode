{
  description = "home-manager configuration";

  inputs = {
    anyrun.url = "github:anyrun-org/anyrun";
    anyrun.inputs.nixpkgs.follows = "nixpkgs";
    catppuccin.url = "github:catppuccin/nix";
    flake-parts = {
      url = "github:hercules-ci/flake-parts";
      inputs.nixpkgs-lib.follows = "nixpkgs";
    };
    home-manager.url = "github:nix-community/home-manager";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";
    ironbar = {
      url = "github:JakeStanger/ironbar";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    niri.url = "github:sodiboo/niri-flake";
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    utils.url = "github:numtide/flake-utils";
    walker = {
      url = "github:abenz1267/walker";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    wired.url = "github:Toqozz/wired-notify";
  };

  outputs = inputs: let system = "x86_64-linux"; in {
    homeConfigurations.rawkode = inputs.home-manager.lib.homeManagerConfiguration {
      pkgs = import inputs.nixpkgs {
        inherit system;

        overlays = [ inputs.wired.overlays.default ];
      };

      extraSpecialArgs = {
        inherit inputs;
      };

      modules = [
        inputs.catppuccin.homeManagerModules.catppuccin
        inputs.anyrun.homeManagerModules.default
        inputs.walker.homeManagerModules.default
        inputs.ironbar.homeManagerModules.default
        inputs.wired.homeManagerModules.default
        ./home.nix
      ];
    };
  };
}
