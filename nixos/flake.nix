{
  description = "p4x-nixos";

  inputs = {
    nixos-cosmic = {
      # https://github.com/lilyinstarlight/nixos-cosmic/pull/157
      url = "github:lxwntr/nixos-cosmic-multiple-de";
      # url = "github:lilyinstarlight/nixos-cosmic";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    home-manager.url = "github:nix-community/home-manager";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";
    niri.url = "github:sodiboo/niri-flake";
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nixos-hardware.url = "github:NixOS/nixos-hardware/master";
  };

  outputs =
    { nixpkgs, ... }@inputs:
    {
      nixosConfigurations.p4x-nixos = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        specialArgs = {
          inherit inputs;
        };

        modules = [
          {
            nix.settings = {
              substituters = [ "https://cosmic.cachix.org/" ];
              trusted-public-keys = [ "cosmic.cachix.org-1:Dya9IyXD4xdBehWjrkPv6rtxpmMdRel02smYzA85dPE=" ];
            };
          }

          inputs.nixos-cosmic.nixosModules.default
          inputs.home-manager.nixosModules.default
          inputs.nixos-hardware.nixosModules.framework-13-7040-amd

          ./configuration.nix
        ];
      };
    };
}
