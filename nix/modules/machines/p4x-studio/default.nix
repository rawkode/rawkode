{ inputs, ... }:
{
  flake.darwinConfigurations.p4x-studio = inputs.nix-darwin.lib.darwinSystem {
    system = "aarch64-darwin";
    modules = [
      inputs.home-manager.darwinModules.home-manager
      inputs.self.darwinModules.nix
      inputs.self.darwinModules.users-rawkode

      # System modules (required for profile settings)
      inputs.self.darwinModules.system-defaults
      inputs.self.darwinModules.power
      inputs.self.darwinModules.fonts

      # Shared profile (sets common config values)
      inputs.self.darwinModules.profiles-darwin-base

      # No firewall - CoreWeave managed device

      # Apps
      inputs.self.darwinModules.fish
      inputs.self.darwinModules.user
      inputs.self.darwinModules.docker

      # Machine-specific config
      {
        networking = {
          hostName = "p4x-studio";
          localHostName = "p4x-studio";
          computerName = "p4x-studio";
        };
      }
    ];
  };

  flake.packages.aarch64-darwin.p4x-studio = inputs.self.darwinConfigurations.p4x-studio.system;
  flake.packages.aarch64-darwin."rawkode@p4x-studio" =
    inputs.self.homeConfigurations."rawkode@p4x-studio".activationPackage;
  flake.p4x-studio = inputs.self.darwinConfigurations.p4x-studio;
}
