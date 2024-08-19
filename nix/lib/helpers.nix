{
  inputs,
  outputs,
  stateVersion,
  username,
  ...
}:
{
  mkHome =
    {
      hostname,
      desktop ? null,
      platform ? "x86_64-linux",
    }:
    inputs.home-manager.lib.homeManagerConfiguration {
      pkgs = inputs.nixpkgs.legacyPackages.${platform};
      extraSpecialArgs = {
        inherit
          desktop
          hostname
          inputs
          outputs
          platform
          stateVersion
          username
          ;
      };
      modules = [ ../home-manager ];
    };

  mkNixos =
    {
      hostname,
      desktop ? null,
      platform ? "x86_64-linux",
    }:
    inputs.nixpkgs.lib.nixosSystem {
      specialArgs = {
        inherit
          desktop
          hostname
          inputs
          outputs
          platform
          stateVersion
          username
          ;
      };

      modules = [ ../nixos ];
    };

  forAllSystems = inputs.nixpkgs.lib.genAttrs [
    "aarch64-linux"
    "i686-linux"
    "x86_64-linux"
    "aarch64-darwin"
    "x86_64-darwin"
  ];
}
