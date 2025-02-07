{ inputs, lib, ... }:
{
  imports = [
    inputs.nixos-facter-modules.nixosModules.facter
    { config.facter.reportPath = ./facter.json; }

    ./disko.nix
  ];

  rawkOS = {
    hardware = {
      cpu = "amd";
      gpu = "amd";
    };

    desktop = {
      gnome.enable = true;
      wayland.force = true;
    };
    secureboot.enable = true;
    displayLink.enable = true;
  };

  systemd.services.NetworkManager-wait-online.enable = lib.mkForce false;
  systemd.services.systemd-networkd-wait-online.enable = lib.mkForce false;

  hardware.enableRedistributableFirmware = true;
  hardware.cpu.amd.updateMicrocode = true;

  hardware.keyboard.qmk.enable = true;
  hardware.graphics = {
    enable = true;
    enable32Bit = true;
  };

  system.stateVersion = "24.11";
}
