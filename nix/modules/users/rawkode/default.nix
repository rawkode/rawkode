{ inputs, ... }:
let
  mkUser = import ../../../lib/mkUser.nix { inherit inputs; };
  machineSystems = import ../../../lib/machineSystems.nix;

  baseImports = with inputs; [
    self.homeModules.profiles-users-common
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
    # Darwin needs stylix explicitly (on NixOS it comes via nixosModules.stylix)
    self.homeModules.stylix
  ];

in
mkUser {
  username = "rawkode";
  name = "David Flanagan";
  email = "david@rawkode.dev";
  signingKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAXwFFDFPDUbAql+V8xMmFxuZe6aUUxDD2cY0Dr0X1g9";
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
