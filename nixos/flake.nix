{
  description = "Rawkode's Dotfiles";

  inputs = {
    nixos-cosmic = {
      # https://github.com/lilyinstarlight/nixos-cosmic/pull/157
      url = "github:lxwntr/nixos-cosmic-multiple-de";
      # url = "github:lilyinstarlight/nixos-cosmic";
      inputs.nixpkgs.follows = "nixpkgs";
    };
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
            {
              nix.settings = {
                substituters = [ "https://cosmic.cachix.org/" ];
                trusted-public-keys = [ "cosmic.cachix.org-1:Dya9IyXD4xdBehWjrkPv6rtxpmMdRel02smYzA85dPE=" ];
              };
            }
            { networking.hostName = "p4x-${device-name}"; }
            ./configuration.nix
            inputs.nixos-cosmic.nixosModules.default
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
      };
    };
}
