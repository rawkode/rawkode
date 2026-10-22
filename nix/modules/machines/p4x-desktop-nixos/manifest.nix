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
      "openclaw"
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

          # Two BenQ EX3210Us side by side: DP-2 on the left, DP-1 on the right.
          # Positions override the shared office layout for these connectors.
          programs.niri.settings.outputs =
            let
              benq = x: {
                mode = {
                  width = 3840;
                  height = 2160;
                  refresh = 144.0;
                };
                variable-refresh-rate = true;
                position = lib.mkForce {
                  inherit x;
                  y = 0;
                };
              };
            in
            {
              "DP-2" = benq 0;
              "DP-1" = benq 1920;
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
