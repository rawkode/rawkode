{ lib, ... }:
{
  flake.machineManifests.p4x-framework-nixos = {
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
      "nixos-amd-hardware"
      "nixos-laptop-amd"
      "nixos-zen-kernel"
      "nixos-secureboot"
      "nixos-encrypted-btrfs"
    ];
    users.rawkode = {
      modules = [
        {
          # Idle sleep on battery matches the lid: suspend, then hibernate.
          programs.dank-material-shell.settings.batterySuspendBehavior = 2;

          # Adaptive brightness from the ambient light sensor (amd_sfh ALS).
          # wluma learns from manual brightness changes per light level.
          # Screen-content capture is disabled to avoid extra GPU work.
          services.wluma = {
            enable = true;
            settings = {
              als.iio = {
                path = "/sys/bus/iio/devices";
                thresholds = {
                  "0" = "night";
                  "20" = "dark";
                  "80" = "dim";
                  "250" = "normal";
                  "500" = "bright";
                  "800" = "outdoors";
                };
              };
              output.backlight = [
                {
                  name = "eDP-1";
                  path = "/sys/class/backlight/amdgpu_bl1";
                  capturer = "none";
                }
              ];
            };
          };
        }
      ];
    };
    modules = [
      {
        rawkOS.disko.device = "/dev/nvme0n1";
        services.fprintd.enable = true;
        boot.kernelParams = [
          "amdgpu.sg_display=0"
          "resume_offset=1251092"
        ];
        boot.kernelModules = [
          "cros_ec"
          "cros_ec_lpcs"
          "mt7921e"
        ];
        environment.variables.QT_AUTO_SCREEN_SCALE_FACTOR = "1";
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
        # Like macOS standby: instant wake for short sleeps, hibernate for long ones.
        services.logind.settings.Login = {
          HandleLidSwitch = "suspend-then-hibernate";
          HandlePowerKey = "suspend-then-hibernate";
        };
        systemd.sleep.settings.Sleep.HibernateDelaySec = "3h";
        services.power-profiles-daemon.enable = lib.mkDefault true;
        # nixos-hardware disables Panel Self Refresh as an old-kernel freeze
        # workaround; PSR lets the iGPU stop refreshing a static screen.
        hardware.amdgpu.dcDebugMask.disablePsr = false;
        # Full preemption and threaded IRQs trade battery for latency.
        rawkOS.kernel.lowLatency = false;
      }
    ];
  };
}
