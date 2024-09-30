{
  config,
  inputs,
  lib,
  modulesPath,
  ...
}:

{
  imports = [
    (modulesPath + "/installer/scan/not-detected.nix")
    inputs.nixos-hardware.nixosModules.framework-13-7040-amd
    inputs.nixos-hardware.nixosModules.common-cpu-amd
    inputs.nixos-hardware.nixosModules.common-cpu-amd-pstate
    inputs.nixos-hardware.nixosModules.common-gpu-amd
    inputs.nixos-hardware.nixosModules.common-hidpi
    ./disko.nix
  ];

  hardware.amdgpu.amdvlk.enable = true;
  programs.corectrl.enable = true;

  services.tlp.enable = lib.mkForce false;

  boot.initrd.availableKernelModules = [
    "nvme"
    "xhci_pci"
    "thunderbolt"
    "usb_storage"
    "sd_mod"
  ];

  boot.loader.systemd-boot.enable = true;
  boot.loader.efi.canTouchEfiVariables = true;
  boot.loader.efi.efiSysMountPoint = "/boot";

  swapDevices = [
    {
      device = "/var/lib/swapfile";
      size = 64 * 1024;
    }
  ];

  services.fprintd.enable = true;

  networking.useDHCP = lib.mkDefault true;
  networking.networkmanager.wifi.powersave = true;
  hardware.cpu.amd.updateMicrocode = lib.mkDefault config.hardware.enableRedistributableFirmware;
}
