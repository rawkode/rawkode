{
  description = "p4x-nixos";

  inputs = {
    ghostty = {
      url = "git+ssh://git@github.com/ghostty-org/ghostty";
    };
    home-manager.url = "github:nix-community/home-manager";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";
    niri.url = "github:sodiboo/niri-flake";
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nixos-hardware.url = "github:NixOS/nixos-hardware/master";
  };

  outputs =
    {
      ghostty,
      home-manager,
      nixpkgs,
      niri,
      nixos-hardware,
      ...
    }@inputs:
    {
      nixosConfigurations.p4x-nixos = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        specialArgs = {
          inherit inputs;
        };

        modules = [
          ./configuration.nix
          { environment.systemPackages = [ ghostty.packages.x86_64-linux.default ]; }
          home-manager.nixosModules.default
          nixos-hardware.nixosModules.framework-13-7040-amd
        ];
      };
    };
}
