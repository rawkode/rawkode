{ inputs, ... }:
{
  flake.darwinConfigurations.p4x-air = inputs.nix-darwin.lib.darwinSystem {
    system = "aarch64-darwin";
    modules = [
      inputs.home-manager.darwinModules.home-manager
      inputs.self.darwinModules.nix

      # Shared profile (sets common config values)
      inputs.self.darwinModules.profiles-base

      # System & Shell
      inputs.self.darwinModules.fish
      inputs.self.darwinModules.user

      # User configuration
      inputs.self.darwinModules.users-rawkode

      # Machine-specific config
      {
        networking = {
          hostName = "p4x-air";
          localHostName = "p4x-air";
          computerName = "p4x-air";
        };

        # Firewall (personal device only)
        rawkOS.darwin.firewall = {
          enable = true;
          stealthMode = true;
          allowSigned = true;
          allowSignedApp = true;
        };
      }
    ];
    specialArgs = {
      inherit inputs;
    };
  };

  flake.packages.aarch64-darwin.p4x-air = inputs.self.darwinConfigurations.p4x-air.system;
}
