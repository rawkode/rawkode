{ inputs, ... }:
{
  flake.darwinConfigurations.p4x-air = inputs.nix-darwin.lib.darwinSystem {
    system = "aarch64-darwin";
    modules = [
      inputs.home-manager.darwinModules.home-manager
      inputs.self.darwinModules.nix

      # System modules (required for profile settings)
      inputs.self.darwinModules.system-defaults
      inputs.self.darwinModules.power
      inputs.self.darwinModules.fonts

      # Shared profile (sets common config values)
      inputs.self.darwinModules.profiles-darwin-base

      # Firewall (personal device only)
      inputs.self.darwinModules.firewall

      # Apps
      inputs.self.darwinModules.fish
      inputs.self.darwinModules.user

      # Machine-specific config
      {
        networking = {
          hostName = "p4x-air";
          localHostName = "p4x-air";
          computerName = "p4x-air";
        };

        rawkOS.darwin.firewall = {
          enable = true;
          stealthMode = true;
          allowSigned = true;
          allowSignedApp = true;
        };
      }
    ];
  };

  flake.packages.aarch64-darwin.p4x-air = inputs.self.darwinConfigurations.p4x-air.system;
  flake.p4x-air = inputs.self.darwinConfigurations.p4x-air;
}
