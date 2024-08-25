{ lib, ... }:
with lib;
with lib.rawkOS;
{
  imports = [ ./hardware.nix ];

  rawkOS = {
    desktop = {
      niri = enabled;
    };
    wayland.force = true;

    secureboot.enable = true;
  };

  networking.hostName = "p4x-desktop-nixos";

  # User Setup
  users.mutableUsers = false;

  # Wireless
  hardware.bluetooth.enable = true;

  # Powersaving Settings
  services.thermald.enable = true;
  services.tlp.enable = true;

  system.stateVersion = "24.05";
}
