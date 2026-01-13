{ inputs, ... }:
{
  flake.darwinConfigurations.p4x-mbp = inputs.nix-darwin.lib.darwinSystem {
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

      # Firewall (personal device only)
      inputs.self.darwinModules.firewall

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
      inputs.self.darwinModules.firefox
      inputs.self.darwinModules.vivaldi
      inputs.self.darwinModules.orion

      # Communication
      inputs.self.darwinModules.slack
      inputs.self.darwinModules.discord
      inputs.self.darwinModules.mimestream
      inputs.self.darwinModules.fastmail

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
      {
        networking = {
          hostName = "p4x-mbp";
          localHostName = "p4x-mbp";
          computerName = "p4x-mbp";
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

  flake.packages.aarch64-darwin.p4x-mbp = inputs.self.darwinConfigurations.p4x-mbp.system;
  flake.packages.aarch64-darwin."rawkode@p4x-mbp" =
    inputs.self.homeConfigurations."rawkode@p4x-mbp".activationPackage;
  flake.p4x-mbp = inputs.self.darwinConfigurations.p4x-mbp;
}
