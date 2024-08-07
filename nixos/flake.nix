{
  description = "rawkOS";

  inputs = {
    catppuccin.url = "github:catppuccin/nix";
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    lanzaboote.url = "github:nix-community/lanzaboote";
    nixos-hardware.url = "github:NixOS/nixos-hardware/master";
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
  };

  outputs =
    inputs:
    let
      mkSystem =
        pkgs: system: device-name: other-modules:
        pkgs.lib.nixosSystem {
          system = system;
          specialArgs = {
            inherit inputs;
          };
          modules = [
            { networking.hostName = "p4x-${device-name}-nixos"; }

            inputs.catppuccin.nixosModules.catppuccin
            inputs.home-manager.nixosModules.default

            (./. + "/hardware/${device-name}/configuration.nix")
            ./configuration.nix
          ] ++ other-modules;
        };
    in
    {
      nixosConfigurations = {
        laptop = mkSystem inputs.nixpkgs "x86_64-linux" "laptop" [
          inputs.nixos-hardware.nixosModules.framework-13-7040-amd
        ];

        desktop = mkSystem inputs.nixpkgs "x86_64-linux" "desktop" [ ];
      };
    };
}
