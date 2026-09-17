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
    users.rawkode = { };
    modules = [
      {
        rawkOS.disko.device = "/dev/nvme0n1";
        swapDevices = [
          {
            device = "/var/lib/swapfile";
            size = 48 * 1024;
          }
        ];
      }
    ];
  };
}
