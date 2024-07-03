{
  description = "Rawkode's Dotfiles";

  inputs = {
    home-manager.url = "github:nix-community/home-manager";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nixos-hardware.url = "github:NixOS/nixos-hardware/master";
  };

  outputs =
    inputs:
    let
      mkSystem =
        pkgs: system: device-name: other-modules:
        pkgs.lib.nixosSystem {
          system = system;
          modules = [
            { networking.hostName = "p4x-${device-name}"; }
            ./configuration.nix
            inputs.home-manager.nixosModules.default
            (./. + "/hardware/${device-name}/configuration.nix")
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
