{ lib, ... }:
{
  flake.machineManifests.p4x-desktop-nixos = {
    platform = "nixos";
    system = "x86_64-linux";
    primaryUser = "rawkode";
    capabilities = [
      "foundation"
      "desktop"
      "productivity"
      "personal-comms"
      "development"
      "platform"
      "tailnet"
    ];
    disabledCapabilities = [ ];
    traits = [
      "nixos-amd-desktop"
      "nixos-zen-kernel"
      "nixos-secureboot"
      "nixos-encrypted-btrfs"
    ];
    users.rawkode = { };
    modules = [
      {
        rawkOS.disko.device = "/dev/nvme0n1";
        zramSwap.enable = true;
        hardware.enableRedistributableFirmware = lib.mkDefault true;
      }
    ];
  };
}
