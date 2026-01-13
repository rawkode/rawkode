{ inputs, ... }:
{
  flake.darwinConfigurations.CW-GG9T93PVFC-L = inputs.nix-darwin.lib.darwinSystem {
    system = "aarch64-darwin";
    modules = [
      inputs.home-manager.darwinModules.home-manager
      inputs.self.darwinModules.nix
      inputs.self.darwinModules.users-dflanagan

      # System modules (required for profile settings)
      inputs.self.darwinModules.system-defaults
      inputs.self.darwinModules.power
      inputs.self.darwinModules.fonts

      # Shared profile (sets common config values)
      inputs.self.darwinModules.profiles-darwin-base

      # Apps
      inputs.self.darwinModules.fish
      inputs.self.darwinModules.user

      # AI & Dev Tools
      inputs.self.darwinModules.ai
      inputs.self.darwinModules.zed
      # inputs.self.darwinModules.visual-studio-code  # Temporarily disabled - cask download failing

      # Browsers
      inputs.self.darwinModules.google-chrome

      # Communication
      inputs.self.darwinModules.slack
      inputs.self.darwinModules.mimestream

      # Productivity & Utilities
      inputs.self.darwinModules.onepassword
      inputs.self.darwinModules.setapp
      inputs.self.darwinModules.skim
      inputs.self.darwinModules.dockdoor
      inputs.self.darwinModules.parallels
      inputs.self.darwinModules.descript

      # Development
      inputs.self.darwinModules.docker
      inputs.self.darwinModules.gcloud

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

          users.users.dflanagan = {
            name = "dflanagan";
            home = "/Users/dflanagan";
          };

          system.primaryUser = lib.mkForce "dflanagan";
        }
      )
    ];
  };

  flake.packages.aarch64-darwin.CW-GG9T93PVFC-L = inputs.self.darwinConfigurations.CW-GG9T93PVFC-L.system;
  flake.CW-GG9T93PVFC-L = inputs.self.darwinConfigurations.CW-GG9T93PVFC-L;
}
