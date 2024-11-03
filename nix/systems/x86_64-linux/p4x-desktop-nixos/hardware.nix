{ config, inputs, lib, modulesPath, ... }:

{
  imports = [
    (modulesPath + "/installer/scan/not-detected.nix")
    inputs.nixos-hardware.nixosModules.common-cpu-amd
    inputs.nixos-hardware.nixosModules.common-cpu-amd-pstate
    inputs.nixos-hardware.nixosModules.common-gpu-amd
    inputs.nixos-hardware.nixosModules.common-hidpi
    inputs.nixos-hardware.nixosModules.common-pc
    inputs.nixos-hardware.nixosModules.common-pc-ssd
    ./disko.nix
  ];

  # Propritary firmware causes problems with GTK
  # https://gitlab.gnome.org/GNOME/gtk/-/issues/6890
  hardware.amdgpu.amdvlk.enable = false;
  hardware.amdgpu.opencl.enable = true;

  boot.initrd.availableKernelModules =
    [ "ahci" "nvme" "sd_mod" "thunderbolt" "usb_storage" "usbhid" "xhci_pci" ];

  networking.useDHCP = lib.mkDefault true;
  hardware.cpu.amd.updateMicrocode =
    lib.mkDefault config.hardware.enableRedistributableFirmware;
}
