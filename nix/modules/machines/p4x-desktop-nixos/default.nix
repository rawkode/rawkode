{ inputs, ... }:
{
  flake.nixosConfigurations.p4x-desktop-nixos = inputs.nixpkgs.lib.nixosSystem {
    system = "x86_64-linux";
    modules = [
      # Hardware modules
      inputs.nixos-hardware.nixosModules.common-pc-ssd
      inputs.nixos-hardware.nixosModules.common-cpu-amd
      inputs.nixos-hardware.nixosModules.common-gpu-amd
      inputs.nixos-hardware.nixosModules.common-cpu-amd-pstate

      # Import profiles (includes disko, lanzaboote, flatpaks via profiles-base)
      inputs.self.nixosModules.kernel
      inputs.self.nixosModules.lanzaboote
      inputs.self.nixosModules.plymouth
      inputs.self.nixosModules.profiles-desktop
      inputs.self.nixosModules.profiles-amd
      inputs.self.nixosModules.disko-btrfs-encrypted

      # User configuration
      inputs.self.nixosModules.users-rawkode

      # Machine-specific configuration
      (
        { lib, ... }:
        {
          # System identity
          networking.hostName = "p4x-desktop-nixos";

          # Disko device override (uses shared configuration from disko-btrfs-encrypted module)
          rawkOS.disko.device = "/dev/nvme0n1";

          # Enable swap
          zramSwap.enable = true;

          # AMD-specific
          hardware.enableRedistributableFirmware = lib.mkDefault true;
        }
      )
    ];
    specialArgs = {
      inherit inputs;
    };
  };
}
