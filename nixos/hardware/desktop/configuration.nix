{
  config,
  lib,
  pkgs,
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

  hardware.graphics = {
    enable = true;
    extraPackages = with pkgs; [
      amdvlk
      # rocmPackages.clr.icd
    ];
  };

  fileSystems."/" = {
    device = "/dev/disk/by-uuid/b0033e60-238e-472f-a986-3dddc49f547b";
    fsType = "btrfs";
  };

  boot.initrd.luks.devices."root".device = "/dev/disk/by-uuid/84063637-cb05-488e-8512-41e9a74adf86";

  fileSystems."/boot" = {
    device = "/dev/disk/by-uuid/E54F-2CD5";
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
