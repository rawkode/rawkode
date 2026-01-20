{ inputs, ... }:
{
  flake.darwinConfigurations.p4x-mbp = inputs.nix-darwin.lib.darwinSystem {
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
          hostName = "p4x-mbp";
          localHostName = "p4x-mbp";
          computerName = "p4x-mbp";
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

  flake.packages.aarch64-darwin.p4x-mbp = inputs.self.darwinConfigurations.p4x-mbp.system;
  flake.packages.aarch64-darwin."rawkode@p4x-mbp" =
    inputs.self.homeConfigurations."rawkode@p4x-mbp".activationPackage;
}
