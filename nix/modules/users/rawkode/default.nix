{ inputs, lib, ... }:
let
  mkUser = import ../../../lib/mkUser.nix { inherit inputs lib; };
  machineSystems = import ../../../lib/machineSystems.nix;
in
mkUser {
  username = "rawkode";
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
    eza
    google-youtube3-cli
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
    discord
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

    # Cloud
    google-cloud

    # Darwin-only apps (no-ops on Linux)
    cursor
    descript
    mimestream
    parallels
  ];

  # Cross-platform imports
  extraImports = [
    inputs.self.homeModules.profiles-users-common
    inputs.self.homeModules.stylix
  ];

  # Linux-only imports (e.g., flatpak, gnome, niri, wayland)
  linuxExtraImports = [
    inputs.flatpaks.homeManagerModules.nix-flatpak
    inputs.ironbar.homeManagerModules.default
    inputs.vicinae.homeManagerModules.default

    inputs.self.homeModules.dconf-editor
    inputs.self.homeModules.flatpak
    inputs.self.homeModules.gnome
    inputs.self.homeModules.ironbar
    inputs.self.homeModules.niri
    inputs.self.homeModules.portals
    inputs.self.homeModules.rquickshare
    inputs.self.homeModules.vicinae
    inputs.self.homeModules.wayland
  ];

  homeExtraConfig =
    { lib, isDarwin, ... }:
    lib.optionalAttrs (!isDarwin) {
      rawkOS.desktop.darkman.enable = false;
    };

  nixosUserConfig = _: {
    extraGroups = [ "libvirtd" ];
  };

  enableHomeConfigurations = true;
  machinesDir = ../../machines;
}
