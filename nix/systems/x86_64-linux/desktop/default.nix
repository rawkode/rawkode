{ ... }:
{
  imports = [ ./hardware.nix ];

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

  # Wireless
  hardware.bluetooth.enable = true;
  networking.networkmanager.enable = true;

  # Powersaving Settings
  services.thermald.enable = true;
  services.tlp.enable = true;

  system.stateVersion = "24.05";
}
