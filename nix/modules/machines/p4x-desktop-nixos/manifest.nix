{ lib, ... }:
{
  flake.machineManifests.p4x-desktop-nixos = {
    platform = "nixos";
    system = "x86_64-linux";
    primaryUser = "rawkode";
    capabilities = [
      "foundation"
      "theming"
      "peripherals-multipass"
      "desktop"
      "productivity"
      "personal-comms"
      "development"
      "platform"
      "vpn"
    ];
    disabledCapabilities = [ ];
    traits = [
      "nixos-hardware-maintenance"
      "nixos-tpm2"
      "nixos-wireless"
      "nixos-amd-desktop"
      "nixos-zen-kernel"
      "nixos-secureboot"
      "nixos-encrypted-btrfs"
    ];
    users.rawkode = {
      modules = [
        {
          # The BenQ on DisplayPort drops its link when woken from DPMS and never
          # reconnects, leaving niri with no output. Lock on idle, never blank.
          programs.dank-material-shell.settings.acMonitorTimeout = lib.mkForce 0;
        }
      ];
    };
    modules = [
      {
        rawkOS.disko.device = "/dev/nvme0n1";
        zramSwap.enable = true;
        hardware.enableRedistributableFirmware = lib.mkDefault true;
      }
    ];
  };
}
