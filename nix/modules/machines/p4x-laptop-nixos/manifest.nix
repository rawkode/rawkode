{
  flake.machineManifests.p4x-laptop-nixos = {
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
