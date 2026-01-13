# Parallels VM system configuration - NixOS with Niri for macOS-hosted development
{ inputs, ... }:
{
  flake.nixosConfigurations.p4x-parallels-nixos = inputs.nixpkgs.lib.nixosSystem {
    system = "aarch64-linux";
    modules = [
      # Flake inputs (lanzaboote needed for option definitions even if disabled)
      inputs.lanzaboote.nixosModules.lanzaboote
      inputs.disko.nixosModules.disko
      inputs.flatpaks.nixosModules.nix-flatpak
      inputs.home-manager.nixosModules.home-manager

      # Import profiles - reuse existing desktop and development setup
      inputs.self.nixosModules.profiles-desktop
      inputs.self.nixosModules.profiles-development
      inputs.self.nixosModules.kernel

      # Disko for declarative disk partitioning
      inputs.self.nixosModules.disko-vm-simple

      # User configuration
      inputs.self.nixosModules.users-rawkode

      # Machine-specific configuration (hardware + settings)
      (
        { lib, pkgs, ... }:
        {
          # System identity
          networking.hostName = "p4x-parallels-nixos";

          # ─────────────────────────────────────────────────────────────────
          # Hardware Configuration for Parallels VM
          # ─────────────────────────────────────────────────────────────────

          # VM guest services
          services.qemuGuest.enable = true;

          # Boot configuration - disable secure boot for VM
          boot = {
            # Disable lanzaboote/secure boot (not needed in VM)
            lanzaboote.enable = lib.mkForce false;

            loader = {
              efi.canTouchEfiVariables = true;
              timeout = 3;
            };

            # Kernel modules for Parallels VM
            initrd.availableKernelModules = [
              "ahci"
              "xhci_pci"
              "virtio_pci"
              "virtio_blk"
              "virtio_scsi"
              "sr_mod"
              "sd_mod"
            ];

            kernelModules = [ ];
          };

          # Disko handles disk partitioning - set device path
          rawkOS.disko.device = "/dev/sda";

          # Platform
          nixpkgs.hostPlatform = lib.mkDefault "aarch64-linux";

          # ─────────────────────────────────────────────────────────────────
          # Parallels Guest Support
          # ─────────────────────────────────────────────────────────────────

          hardware.parallels = {
            enable = true;
            autoMountShares = true;
          };

          # Graphics for Wayland in VM
          hardware.graphics.enable = true;
          services.xserver.videoDrivers = [ "modesetting" ];

          # Firmware
          hardware.enableRedistributableFirmware = true;

          # ─────────────────────────────────────────────────────────────────
          # VM-specific Settings
          # ─────────────────────────────────────────────────────────────────

          # VM doesn't need laptop power management
          services.thermald.enable = false;
          services.power-profiles-daemon.enable = false;

          # Swap (smaller than physical machine)
          swapDevices = [
            {
              device = "/var/lib/swapfile";
              size = 8 * 1024; # 8GB
            }
          ];

          # VM-specific networking (Parallels handles NAT)
          networking = {
            useDHCP = lib.mkDefault true;
            firewall.enable = true;
          };

          # Nix settings - reuse cachix substituters for niri
          nix.settings = {
            substituters = [
              "https://niri.cachix.org"
            ];
            trusted-public-keys = [
              "niri.cachix.org-1:Wv0OmO7PsuocRKzfDoJ3mulSl7Z6oezYhGhR+3W2964="
            ];
          };
        }
      )
    ];
    specialArgs = {
      inherit inputs;
    };
  };
}
