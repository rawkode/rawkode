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

      # AI & Dev Tools
      inputs.self.darwinModules.ai
      inputs.self.darwinModules.cursor
      inputs.self.darwinModules.zed
      inputs.self.darwinModules.visual-studio-code

      # Terminals
      inputs.self.darwinModules.wezterm

      # Browsers
      inputs.self.darwinModules.google-chrome

      # Communication
      inputs.self.darwinModules.slack
      inputs.self.darwinModules.discord
      inputs.self.darwinModules.mimestream

      # Productivity & Utilities
      inputs.self.darwinModules.onepassword
      inputs.self.darwinModules.setapp
      inputs.self.darwinModules.parallels
      inputs.self.darwinModules.descript

      # Development
      inputs.self.darwinModules.google-cloud

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
