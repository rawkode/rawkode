{ ... }:
{
  imports = [ ./hardware.nix ];

  rawkOS = {
    desktop = {
      niri.enable = true;
      wayland.force = true;
    };
    secureboot.enable = true;
  };

  # Wireless
  hardware.bluetooth.enable = true;

  # Powersaving Settings
  services.thermald.enable = true;
  services.tlp.enable = true;

  system.stateVersion = "24.05";
}
