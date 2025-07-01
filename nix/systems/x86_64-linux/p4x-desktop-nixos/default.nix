{ inputs
, lib
, pkgs
, ...
}:
{
  imports = [
    inputs.nixos-facter-modules.nixosModules.facter
    { config.facter.reportPath = ./facter.json; }

    inputs.nixos-hardware.nixosModules.common-pc-ssd
    inputs.nixos-hardware.nixosModules.common-cpu-amd
    inputs.nixos-hardware.nixosModules.common-gpu-amd
    inputs.nixos-hardware.nixosModules.common-cpu-amd-pstate

    ./disko.nix
  ];

  rawkOS = {
    hardware = {
      cpu = "amd";
      gpu = "amd";
    };

    desktop = {
      wayland.force = true;
    };
    secureboot.enable = true;
  };

  boot.kernelParams = [
    "video=DP-1:2160@144"
    "video=DP-2:3840x2160@144"
  ];

  systemd.services.NetworkManager-wait-online.enable = lib.mkForce false;
  systemd.services.systemd-networkd-wait-online.enable = lib.mkForce false;

  hardware.enableRedistributableFirmware = true;
  hardware.cpu.amd.updateMicrocode = true;

  hardware.keyboard.qmk.enable = true;

  system.stateVersion = "25.05";
}
