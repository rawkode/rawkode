{ lib, ... }:
{
  flake.machineManifests.p4x-framework-nixos = {
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
      "nixos-framework-13-7040-amd"
      "nixos-amd-hardware"
      "nixos-laptop-amd"
      "nixos-zen-kernel"
      "nixos-secureboot"
      "nixos-encrypted-btrfs"
    ];
    users.rawkode = { };
    modules = [
      {
        rawkOS.disko.device = "/dev/nvme0n1";
        services.fprintd.enable = true;
        boot.kernelParams = [ "amdgpu.sg_display=0" ];
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
        services.power-profiles-daemon.enable = lib.mkDefault true;
      }
    ];
  };
}
