{ inputs, ... }:
{
  flake.darwinConfigurations.p4x-studio = inputs.nix-darwin.lib.darwinSystem {
    system = "aarch64-darwin";
    modules = [
      inputs.home-manager.darwinModules.home-manager
      inputs.self.darwinModules.nix
      inputs.self.darwinModules.users-rawkode

      # Shared profile (sets common config values)
      inputs.self.darwinModules.profiles-base

      # System & Shell
      inputs.self.darwinModules.fish
      inputs.self.darwinModules.user

      # Machine-specific config
      {
        networking = {
          hostName = "p4x-studio";
          localHostName = "p4x-studio";
          computerName = "p4x-studio";
        };
      }
    ];
    specialArgs = {
      inherit inputs;
    };
  };

  flake.packages.aarch64-darwin.p4x-studio = inputs.self.darwinConfigurations.p4x-studio.system;
  flake.packages.aarch64-darwin."rawkode@p4x-studio" =
    inputs.self.homeConfigurations."rawkode@p4x-studio".activationPackage;
}
