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
  # Note: Only apps in modules/apps/ that use mkApp are available here.
  # Other modules (shells, config, programs) should be in extraImports.
  apps = with inputs.self.appBundles; [
    # CLI Tools
    bat
    btop
    coreweave
    eza
    htop
    jq
    misc
    ripgrep

    # Shells & Shell Utilities
    atuin
    carapace
    fish
    nushell
    starship
    zoxide

    # Terminals
    ghostty

    # Editors & AI
    ai
    pi
    visual-studio-code
    zed

    # Browsers
    google-chrome

    # Communication
    slack

    # Productivity
    handy
    onepassword
    tana
    zoom

    # Version Control
    git
    github
    jj

    # Development Tools
    bun
    comma
    cue
    cuenv
    deno
    devenv
    direnv
    go
    just
    kubernetes
    nh
    nix-dev
    podman
    python
    rust

    # Darwin-only apps (no-ops on Linux)
    cursor
    descript
    mimestream
    parallels
    setapp
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
