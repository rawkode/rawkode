{ inputs, ... }:
let
  mkUser = import ../../../lib/mk-user.nix { inherit inputs; };
  machineSystems = import ../../../lib/machine-systems.nix;

  linuxImports = with inputs; [
    nix-index-database.homeModules.nix-index
    nur.modules.homeManager.default
    flatpaks.homeManagerModules.nix-flatpak
    ironbar.homeManagerModules.default
    vicinae.homeManagerModules.default

    self.homeModules.ai
    self.homeModules.profiles-command-line
    self.homeModules.profiles-desktop
    self.homeModules.profiles-development
    self.homeModules.fish
    self.homeModules.flatpak
    self.homeModules.gnome
    self.homeModules.ironbar
    self.homeModules.nix-home
    self.homeModules.portals
    self.homeModules.stylix
    self.homeModules.vicinae
  ];

  darwinImports = with inputs; [
    # NOTE: fish, starship, atuin, carapace, comma, and zoxide are
    # already imported via the command-line profile - don't duplicate them!

    # Editor and CLI toolkit
    self.homeModules.profiles-command-line

    # Nix CLI config for HM (required by modules that set nix.settings)
    self.homeModules.nix-home

    # Developer tooling (Docker client, Podman, language toolchains, etc.)
    self.homeModules.profiles-development

    # Apps and theming
    self.homeModules.ghostty
    self.homeModules.git
    self.homeModules.stylix
  ];

in
mkUser {
  username = "rawkode";
  name = "David Flanagan";
  inherit machineSystems;
  homeImports = {
    linux = linuxImports;
    darwin = darwinImports;
  };
  homeExtraConfig =
    { lib, isDarwin, ... }:
    lib.optionalAttrs (!isDarwin) {
      rawkOS.desktop.darkman.enable = false;
    };
  nixosUserConfig =
    _:
    {
      extraGroups = [
        "audio"
        "docker"
        "input"
        "libvirtd"
        "video"
        "wheel"
      ];
    };
  enableHomeConfigurations = true;
  machinesDir = ../../machines;
}
