{ lib, ... }:
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
          # Idle sleep on battery matches the lid: suspend, then hibernate.
          programs.dank-material-shell.settings = {
            batterySuspendBehavior = 2;
            # Power Saver on battery, Balanced on AC ("0"/"1"/"2" = saver/balanced/performance).
            batteryProfileName = "0";
            acProfileName = "1";
            # Drop the 120Hz panel to 60Hz when unplugged.
            lowerDisplayRefreshRateOnBattery = true;
            # The panel is the biggest idle draw; don't leave it lit behind the lock screen.
            batteryMonitorTimeout = lib.mkForce 300;
            batteryPostLockMonitorTimeout = 60;
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

        # The shared 32-sample quantum keeps the CPU waking ~1500 times a second
        # whenever audio is open. Default to 1024 here, but still let apps that
        # ask for low latency drop to 32.
        services.pipewire.extraConfig.pipewire."92-low-latency" = lib.mkForce {
          context.properties = {
            default.clock.rate = 48000;
            default.clock.quantum = 1024;
            default.clock.min-quantum = 32;
            default.clock.max-quantum = 2048;
          };
        };
      }
    ];
  };
}
