{ inputs, ... }:
{
  flake.nixosConfigurations.p4x-desktop-nixos = inputs.nixpkgs.lib.nixosSystem {
    system = "x86_64-linux";
    modules = with inputs; [
      # Hardware modules
      nixos-hardware.nixosModules.common-pc-ssd
      nixos-hardware.nixosModules.common-cpu-amd
      nixos-hardware.nixosModules.common-gpu-amd
      nixos-hardware.nixosModules.common-cpu-amd-pstate

      # Flake inputs
      disko.nixosModules.disko
      lanzaboote.nixosModules.lanzaboote
      flatpaks.nixosModules.nix-flatpak

      # Import profiles
      self.nixosModules.kernel
      self.nixosModules.lanzaboote
      self.nixosModules.plymouth
      self.nixosModules.profiles-desktop
      self.nixosModules.profiles-amd
      self.nixosModules.disko-btrfs-encrypted

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
