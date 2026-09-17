{
  flake.machineManifests.p4x-parallels-nixos = {
    platform = "nixos";
    system = "aarch64-linux";
    primaryUser = "rawkode";
    capabilities = [
      "foundation"
      "theming"
      "peripherals-multipass"
      "desktop"
      "development"
      "platform"
      "vpn"
    ];
    disabledCapabilities = [ ];
    traits = [
      # Preserve the VM's existing service policy during the ownership split.
      "nixos-hardware-maintenance"
      "nixos-tpm2"
      "nixos-wireless"
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
