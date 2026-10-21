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

          # BenQ EX3210U: pin its 144Hz mode and enable adaptive sync.
          programs.niri.settings.outputs."DP-1" = {
            mode = {
              width = 3840;
              height = 2160;
              refresh = 144.0;
            };
            variable-refresh-rate = true;
          };
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
