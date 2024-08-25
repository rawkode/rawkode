{ lib, ... }:
with lib;
with lib.rawkOS;
{
  imports = [
    ./hardware.nix
  ];

  # olistrik = {
  #   collections = {
  #     personal = enabled;
  #     workstation = enabled;
  #   };

  #   wayland = {
  #     niri = enabled;
  #     ags = enabled;
  #   };
  # };

  # User Setup
  users.mutableUsers = false;

  # Wireless
  hardware.bluetooth.enable = true;
  networking.networkmanager.enable = true;

  # Powersaving Settings
  services.thermald.enable = true;
  services.tlp.enable = true;

  system.stateVersion = "24.05";
}
