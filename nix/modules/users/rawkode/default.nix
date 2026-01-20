{ inputs, lib, ... }:
let
  mkUser = import ../../../lib/mkUser.nix { inherit inputs lib; };
  machineSystems = import ../../../lib/machineSystems.nix;

  baseImports = [
    inputs.self.homeModules.profiles-users-common
  ];

  linuxImports = [
    inputs.flatpaks.homeManagerModules.nix-flatpak
    inputs.ironbar.homeManagerModules.default
    inputs.vicinae.homeManagerModules.default

    # Linux-only desktop apps
    inputs.self.homeModules.visual-studio-code
    inputs.self.homeModules.alacritty
    inputs.self.homeModules.clickup
    inputs.self.homeModules.dconf-editor
    inputs.self.homeModules.flatpak
    inputs.self.homeModules.gnome
    inputs.self.homeModules.ironbar
    inputs.self.homeModules.niri
    inputs.self.homeModules.portals
    inputs.self.homeModules.ptyxis
    inputs.self.homeModules.rquickshare
    inputs.self.homeModules.slack
    inputs.self.homeModules.spotify
    inputs.self.homeModules.tana
    inputs.self.homeModules.vicinae
    inputs.self.homeModules.wayland
    inputs.self.homeModules.zoom
    inputs.self.homeModules.zulip
  ];

  darwinImports = [
    # Darwin needs stylix explicitly (on NixOS it comes via nixosModules.stylix)
    inputs.self.homeModules.stylix
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
