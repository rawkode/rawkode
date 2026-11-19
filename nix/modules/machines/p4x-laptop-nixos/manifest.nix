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
      "nixos-tuxedo-infinitybook-pro14-gen9-amd"
      "nixos-laptop-amd"
      "nixos-secureboot"
      "nixos-encrypted-btrfs"
    ];
    users.rawkode = {
      modules = [
        {
          # Turn the display off before suspending so it doesn't stay lit while locked.
          programs.noctalia.settings.idle.behavior.screen-off.timeout = 900;
          # Suspend then hibernate after the lock has been active for a while.
          programs.noctalia.settings.idle.behavior.suspend = {
            timeout = 1200;
            action = "command";
            command = "systemctl suspend-then-hibernate";
          };
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

        # Wi-Fi power saving is off by default in iwlwifi.
        boot.extraModprobeConfig = ''
          options iwlwifi power_save=1
        '';
      }
    ];
  };
}
