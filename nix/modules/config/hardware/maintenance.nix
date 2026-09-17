{ inputs, ... }:
{
  flake.nixosModules.hardware-maintenance = {
    services = {
      fwupd.enable = true;
      hardware.bolt.enable = true;
      pcscd.enable = true;
      smartd.enable = true;
    };
  };

  flake.machineTraits.nixos-hardware-maintenance.nixos = [
    inputs.self.nixosModules.hardware-maintenance
  ];
}
