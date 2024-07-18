{
  description = "Rawkode's Dotfiles";

  inputs = {
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    lanzaboote = {
      url = "github:nix-community/lanzaboote/v0.3.0";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixpkgs.url = "github:nixos/nixpkgs/nixos-24.05";
    nixos-hardware.url = "github:NixOS/nixos-hardware/master";
    unstable.url = "github:nixos/nixpkgs/nixos-unstable";
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
            {
              nix.settings = {
                substituters = [ "https://cosmic.cachix.org/" ];
                trusted-public-keys = [ "cosmic.cachix.org-1:Dya9IyXD4xdBehWjrkPv6rtxpmMdRel02smYzA85dPE=" ];
              };
            }
            { networking.hostName = "p4x-${device-name}-nixos"; }
            inputs.lanzaboote.nixosModules.lanzaboote
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
