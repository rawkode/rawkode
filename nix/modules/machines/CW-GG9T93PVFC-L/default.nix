{ inputs, ... }:
{
  flake.darwinConfigurations.CW-GG9T93PVFC-L = inputs.nix-darwin.lib.darwinSystem {
    system = "aarch64-darwin";
    modules = [
      inputs.home-manager.darwinModules.home-manager
      inputs.self.darwinModules.nix
      inputs.self.darwinModules.users-dflanagan

      # Shared profile (sets common config values)
      inputs.self.darwinModules.profiles-base

      # System & Shell
      inputs.self.darwinModules.fish
      inputs.self.darwinModules.user

      # Machine-specific config
      {
        networking = {
          hostName = "CW-GG9T93PVFC-L";
          localHostName = "CW-GG9T93PVFC-L";
          computerName = "CW-GG9T93PVFC-L";
        };
      }
    ];
    specialArgs = {
      inherit inputs;
      machine = "CW-GG9T93PVFC-L";
    };
  };

  flake.packages.aarch64-darwin.CW-GG9T93PVFC-L =
    inputs.self.darwinConfigurations.CW-GG9T93PVFC-L.system;
}
