{
  flake.machineManifests.p4x-parallels-nixos = {
    platform = "nixos";
    system = "aarch64-linux";
    primaryUser = "rawkode";
    capabilities = [
      "foundation"
      "desktop"
      "development"
      "platform"
      "vpn"
    ];
    disabledCapabilities = [ ];
    traits = [
      "nixos-zen-kernel"
      "parallels-vm"
    ];
    users.rawkode = { };
    modules = [
      {
        rawkOS.disko.device = "/dev/sda";
        swapDevices = [
          {
            device = "/var/lib/swapfile";
            size = 8 * 1024;
          }
        ];
      }
    ];
  };
}
