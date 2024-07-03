{
  description = "Rawkode's Dotfiles";

  inputs = {
    cosmic = {
      url = "github:lilyinstarlight/nixos-cosmic";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    home-manager.url = "github:nix-community/home-manager";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";
    niri.url = "github:sodiboo/niri-flake";
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
            { networking.hostName = "p4x-${device-name}"; }
            ./configuration.nix
            inputs.cosmic.nixosModules.default
            inputs.home-manager.nixosModules.default
            inputs.niri.nixosModules.niri
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
