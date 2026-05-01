{
  inputs,
  config,
  lib,
  ...
}:
let
  mkMachine = import ../../lib/mkMachine.nix { inherit inputs lib; };
  generated = mkMachine.mkMachines {
    manifests = config.flake.machineManifests;
    traits = config.flake.machineTraits;
  };
in
{
  flake.machineTraits = {
    nixos-amd-desktop.nixos = [
      inputs.nixos-hardware.nixosModules.common-pc-ssd
      inputs.nixos-hardware.nixosModules.common-cpu-amd
      inputs.nixos-hardware.nixosModules.common-gpu-amd
      inputs.nixos-hardware.nixosModules.common-cpu-amd-pstate
      inputs.self.nixosModules.amdctl
      inputs.self.nixosModules.lact
      inputs.self.nixosModules.hardware-amd
      inputs.self.nixosModules.hardware-cpu-amd
      inputs.self.nixosModules.hardware-gpu-amd
    ];

    nixos-amd-hardware.nixos = [
      inputs.self.nixosModules.hardware-amd
    ];

    nixos-encrypted-btrfs.nixos = [
      inputs.self.nixosModules.disko-btrfs-encrypted
    ];

    nixos-framework-13-7040-amd.nixos = [
      inputs.nixos-hardware.nixosModules.framework-13-7040-amd
    ];

    nixos-laptop-amd.nixos = [
      (
        { pkgs, ... }:
        {
          services = {
            thermald.enable = true;
            upower = {
              enable = true;
              percentageLow = 15;
              percentageCritical = 7;
              percentageAction = 5;
              criticalPowerAction = "Hibernate";
            };
            logind.settings.Login = {
              HandleLidSwitch = "suspend-then-hibernate";
              HandleLidSwitchExternalPower = "lock";
              HandlePowerKey = "suspend-then-hibernate";
              HibernateDelaySec = 3600;
            };
            libinput = {
              enable = true;
              touchpad = {
                naturalScrolling = true;
                tapping = true;
                clickMethod = "clickfinger";
                disableWhileTyping = true;
              };
            };
          };

          environment.systemPackages = with pkgs; [
            powertop
            acpi
            brightnessctl
          ];

          hardware = {
            enableRedistributableFirmware = true;
            cpu.amd.updateMicrocode = true;
            keyboard.qmk.enable = true;
            graphics.enable = true;
          };
        }
      )
    ];

    nixos-secureboot.nixos = [
      inputs.self.nixosModules.lanzaboote
    ];

    nixos-vm-simple-disko.nixos = [
      inputs.self.nixosModules.disko-vm-simple
    ];

    nixos-zen-kernel.nixos = [
      inputs.self.nixosModules.kernel
    ];

    parallels-vm.nixos = [
      (
        { lib, ... }:
        {
          imports = [
            inputs.self.nixosModules.disko-vm-simple
          ];

          services.qemuGuest.enable = true;

          boot = {
            lanzaboote.enable = lib.mkForce false;
            loader = {
              efi.canTouchEfiVariables = true;
              grub.enable = lib.mkForce false;
              systemd-boot = {
                enable = true;
                memtest86.enable = lib.mkForce false;
              };
              timeout = lib.mkForce 3;
            };
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

          nixpkgs.hostPlatform = lib.mkDefault "aarch64-linux";

          hardware = {
            parallels.enable = true;
            graphics.enable = true;
            enableRedistributableFirmware = true;
          };

          services.xserver.videoDrivers = [ "modesetting" ];

          services.thermald.enable = false;
          services.power-profiles-daemon.enable = false;

          networking = {
            useDHCP = lib.mkDefault true;
            firewall.enable = true;
          };
        }
      )
    ];
  };

  flake.nixosConfigurations = generated.nixosConfigurations;
  flake.darwinConfigurations = generated.darwinConfigurations;
  flake.packages.aarch64-darwin = generated.darwinPackages;
}
