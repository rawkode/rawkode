{ lib, ... }:
{
  imports = [ ./hardware.nix ];

  rawkOS = {
    desktop = {
      gnome.enable = true;
      wayland.force = true;
    };
    secureboot.enable = true;
  };

  systemd.services.NetworkManager-wait-online.enable = lib.mkForce false;
  systemd.services.systemd-networkd-wait-online.enable = lib.mkForce false;

  programs.dconf.enable = true;

  # Powersaving Settings
  services.thermald.enable = true;

  system.stateVersion = "24.05";
}
