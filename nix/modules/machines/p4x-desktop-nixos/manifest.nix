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
      standaloneHomeConfiguration = false;
      modules = [
        {
          # The BenQ on DisplayPort drops its link when its monitors wake from DPMS
          # and never reconnects, so the desktop locks on idle and never powers
          # the outputs off.
          programs.noctalia.settings.idle.behavior.screen-off.enabled = false;

          programs.umbriel.settings.output = {
            "DP-2" = {
              mode = "3840x2160@144";
              position = [
                0
                0
              ];
            };
            "DP-1" = {
              mode = "3840x2160@144";
              position = [
                1920
                0
              ];
            };
          };
        }
      ];
    };
    modules = [
      {
        rawkOS.disko.device = "/dev/nvme0n1";
        zramSwap.enable = true;
        hardware.enableRedistributableFirmware = lib.mkDefault true;
        services.nordvpn.enable = true;
        users.users.rawkode.extraGroups = [ "nordvpn" ];
      }
    ];
  };
}
