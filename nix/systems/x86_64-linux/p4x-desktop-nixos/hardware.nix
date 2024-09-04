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
    inputs.nixos-hardware.nixosModules.common-cpu-amd
    inputs.nixos-hardware.nixosModules.common-cpu-amd-pstate
    inputs.nixos-hardware.nixosModules.common-gpu-amd
    inputs.nixos-hardware.nixosModules.common-hidpi
    inputs.nixos-hardware.nixosModules.common-pc
    inputs.nixos-hardware.nixosModules.common-pc-ssd
  ];

  hardware.amdgpu.amdvlk.enable = true;
  hardware.amdgpu.opencl.enable = true;

  boot.initrd.availableKernelModules = [
    "ahci"
    "nvme"
    "sd_mod"
    "thunderbolt"
    "usb_storage"
    "usbhid"
    "xhci_pci"
  ];

  fileSystems."/" = {
    device = "/dev/disk/by-uuid/87b9151f-3f38-470c-8ad0-3f9e52d61699";
    fsType = "btrfs";
    options = [ "subvol=root" ];
  };

  boot.initrd.luks.devices."root".device = "/dev/disk/by-uuid/9466694a-df7b-48e7-83f6-267cc22e199d";

  fileSystems."/home" = {
    device = "/dev/disk/by-uuid/87b9151f-3f38-470c-8ad0-3f9e52d61699";
    fsType = "btrfs";
    options = [ "subvol=home" ];
  };

  fileSystems."/nix" = {
    device = "/dev/disk/by-uuid/87b9151f-3f38-470c-8ad0-3f9e52d61699";
    fsType = "btrfs";
    options = [ "subvol=nix" ];
  };

  fileSystems."/snapshots" = {
    device = "/dev/disk/by-uuid/87b9151f-3f38-470c-8ad0-3f9e52d61699";
    fsType = "btrfs";
    options = [ "subvol=snapshots" ];
  };

  fileSystems."/boot" = {
    device = "/dev/disk/by-uuid/5917-6457";
    fsType = "vfat";
    options = [
      "fmask=0022"
      "dmask=0022"
    ];
  };

  swapDevices = [ ];

  networking.useDHCP = lib.mkDefault true;
  hardware.cpu.amd.updateMicrocode = lib.mkDefault config.hardware.enableRedistributableFirmware;
}
