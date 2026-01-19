{ inputs, ... }:
let
  mkUser = import ../../../lib/mk-user.nix { inherit inputs; };
  machineSystems = import ../../../lib/machine-systems.nix;

  baseImports = with inputs; [
    nix-index-database.homeModules.nix-index
    nur.modules.homeManager.default

    self.homeModules.ai
    self.homeModules.profiles-home
    self.homeModules.profiles-desktop
    self.homeModules.fish
    self.homeModules.nix-home
    self.homeModules.stylix
  ];

  linuxImports = with inputs; [
    flatpaks.homeManagerModules.nix-flatpak
    ironbar.homeManagerModules.default
    vicinae.homeManagerModules.default

    # Linux-only desktop apps
    self.homeModules.visual-studio-code
    self.homeModules.alacritty
    self.homeModules.clickup
    self.homeModules.dconf-editor
    self.homeModules.flatpak
    self.homeModules.gnome
    self.homeModules.ironbar
    self.homeModules.niri
    self.homeModules.portals
    self.homeModules.ptyxis
    self.homeModules.rquickshare
    self.homeModules.slack
    self.homeModules.spotify
    self.homeModules.tana
    self.homeModules.vicinae
    self.homeModules.wayland
    self.homeModules.zoom
    self.homeModules.zulip
  ];

  darwinImports = with inputs; [
  ];

in
mkUser {
  username = "rawkode";
  name = "David Flanagan";
  inherit machineSystems;
  homeImports = {
    linux = linuxImports ++ baseImports;
    darwin = darwinImports ++ baseImports;
  };
  homeExtraConfig =
    { lib, isDarwin, ... }:
    lib.optionalAttrs (!isDarwin) {
      rawkOS.desktop.darkman.enable = false;
    };
  nixosUserConfig = _: {
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
