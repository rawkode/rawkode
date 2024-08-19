{
  config,
  lib,
  modulesPath,
  ...
}:

{
  imports = [ (modulesPath + "/installer/scan/not-detected.nix") ];

  boot.initrd.availableKernelModules = [
    "nvme"
    "thunderbolt"
    "xhci_pci"
    "ahci"
    "usbhid"
    "usb_storage"
    "sd_mod"
  ];
  boot.initrd.kernelModules = [ ];
  boot.kernelModules = [ "kvm-amd" ];
  boot.extraModulePackages = [ ];

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

  nixpkgs.hostPlatform = lib.mkDefault "x86_64-linux";
  hardware.cpu.amd.updateMicrocode = lib.mkDefault config.hardware.enableRedistributableFirmware;
}
