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
      (
        { lib, ... }:
        {
          networking = {
            hostName = "CW-GG9T93PVFC-L";
            localHostName = "CW-GG9T93PVFC-L";
            computerName = "CW-GG9T93PVFC-L";
          };

          rawkOS.user.username = "dflanagan";

          # CoreWeave-managed device: disable firewall automation
          rawkOS.darwin.firewall.enable = false;

          users.users.dflanagan = {
            name = "dflanagan";
            home = "/Users/dflanagan";
          };

          system.primaryUser = lib.mkForce "dflanagan";
        }
      )
    ];
    specialArgs = {
      inherit inputs;
    };
  };

  flake.packages.aarch64-darwin.CW-GG9T93PVFC-L =
    inputs.self.darwinConfigurations.CW-GG9T93PVFC-L.system;
}
