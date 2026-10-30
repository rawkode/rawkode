{
  flake.machineManifests.p4x-laptop-nixos = {
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
      "nixos-framework-13-7040-amd"
      "nixos-laptop-amd"
      "nixos-secureboot"
      "nixos-encrypted-btrfs"
    ];
    users.rawkode = {
      modules = [
        {
          # Idle sleep on battery matches the lid: suspend, then hibernate.
          programs.dank-material-shell.settings.batterySuspendBehavior = 2;
        }
      ];
    };
    modules = [
      {
        rawkOS.disko.device = "/dev/nvme0n1";
        boot.kernelParams = [ "resume_offset=13206281" ];
        swapDevices = [
          {
            device = "/var/lib/swapfile";
            size = 96 * 1024;
          }
        ];
        # Hibernate into the btrfs swapfile. The offset comes from
        # `btrfs inspect-internal map-swapfile -r /var/lib/swapfile` and must be
        # refreshed if the swapfile is ever recreated.
        boot.resumeDevice = "/dev/mapper/encrypted";
      }
    ];
  };
}
