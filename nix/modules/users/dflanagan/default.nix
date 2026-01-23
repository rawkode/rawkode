{ inputs, lib, ... }:
let
  mkUser = import ../../../lib/mkUser.nix { inherit inputs lib; };
  machineSystems = import ../../../lib/machineSystems.nix;
in
mkUser {
  username = "dflanagan";
  name = "David Flanagan";
  email = "david@rawkode.dev";
  signingKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAXwFFDFPDUbAql+V8xMmFxuZe6aUUxDD2cY0Dr0X1g9";
  inherit machineSystems;

  # Type-safe app imports with LSP auto-complete!
  apps = with inputs.self.appBundles; [
    # CLI Tools
    bat
    btop
    eza
    helix
    htop
    jq
    misc
    ripgrep
    zellij

    # Terminals
    ghostty

    # Editors & AI
    ai
    zed

    # Browsers
    google-chrome

    # Communication
    slack

    # Productivity
    onepassword
    descript
    parallels
    setapp

    # Development
    google-cloud
  ];

  # Additional non-app imports
  extraImports = [
    # Profile modules
    inputs.self.homeModules.profiles-users-common
    inputs.self.homeModules.stylix
  ];

  homeExtraConfig = {
    programs.git.includes = [
      {
        condition = "gitdir:~/Code/src/github.com/coreweave/";
        contents.user.email = "dflanagan@coreweave.com";
      }
    ];
  };

  enableHomeConfigurations = true;
  machinesDir = ../../machines;
}
