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

    orbstack-vm.nixos = [
      (
        {
          lib,
          modulesPath,
          ...
        }:
        {
          imports = [
            # OrbStack runs NixOS as an LXC/Incus container; this sets
            # `boot.isContainer`, which neutralises the bootloader, kernel,
            # firmware, lanzaboote and TPM modules pulled in by `foundation`.
            "${modulesPath}/virtualisation/lxc-container.nix"
          ];

          nixpkgs.hostPlatform = lib.mkDefault "aarch64-linux";

          # OrbStack (boot.isContainer) mounts the btrfs root subvolume itself,
          # so NixOS must not manage any filesystems. `foundation`'s common
          # module otherwise sets fileSystems."/".options, leaving a partial
          # entry with no fsType that breaks evaluation.
          fileSystems = lib.mkForce { };

          # OrbStack guest integration (paths provided by the OrbStack agent,
          # stable across rebuilds, mounted at /opt/orbstack-guest).
          environment.shellInit = ''
            . /opt/orbstack-guest/etc/profile-early
            . /opt/orbstack-guest/etc/profile-late
          '';
          programs.ssh.extraConfig = ''
            Include /opt/orbstack-guest/etc/ssh_config
          '';
          users.groups.orbstack.gid = 67278;

          # Rosetta-backed emulation for x86 builds inside the VM.
          nix.settings.extra-platforms = [
            "x86_64-linux"
            "i686-linux"
          ];

          # Networking: OrbStack uses systemd-networkd on eth0 with its own
          # resolv.conf. `foundation` already forces NetworkManager/dhcpcd off
          # and enables networkd, but enables resolved — which conflicts with
          # OrbStack managing /etc/resolv.conf, so force it off here.
          networking = {
            dhcpcd.enable = lib.mkForce false;
            useDHCP = false;
            useHostResolvConf = false;
            resolvconf.enable = lib.mkForce false;
            wireless.iwd.enable = lib.mkForce false;
          };
          services.resolved.enable = lib.mkForce false;
          services.chrony.enable = lib.mkForce false;
          environment.etc."resolv.conf".source = "/opt/orbstack-guest/etc/resolv.conf";

          systemd.network = {
            enable = true;
            networks."50-eth0" = {
              matchConfig.Name = "eth0";
              networkConfig = {
                DHCP = "ipv4";
                IPv6AcceptRA = true;
              };
              linkConfig.RequiredForOnline = "routable";
            };
          };

          # Headless container: no display-manager/greeter (foundation's greetd
          # would otherwise try to launch a niri-session) and OrbStack provides
          # its own SSH access, so disable the NixOS sshd.
          services.greetd.enable = lib.mkForce false;
          services.openssh.enable = lib.mkForce false;

          # Match OrbStack's host-owned user mapping. Home Manager validates
          # the configured UID against the live account before activation.
          users.groups.rawkode.gid = lib.mkForce 502;
          users.users.rawkode = {
            isNormalUser = lib.mkForce false;
            isSystemUser = lib.mkForce true;
            uid = lib.mkForce 502;
            group = "rawkode";
            home = lib.mkForce "/home/rawkode";
            extraGroups = [ "orbstack" ];
          };

          # Containers cannot set the host clock, mount debugfs, or access a
          # host TPM resource manager.
          rawkOS.tpm2.enable = false;
          security.tpm2 = {
            enable = lib.mkForce false;
            abrmd.enable = lib.mkForce false;
            pkcs11.enable = lib.mkForce false;
            tctiEnvironment.enable = lib.mkForce false;
          };
          systemd.suppressedSystemUnits = [
            "chronyd.service"
            "sys-kernel-debug.mount"
            "tpm2-abrmd.service"
          ];

          # OrbStack's lightweight VM has unreliable watchdog timing; disable
          # the systemd watchdog on core services so they aren't killed.
          systemd.services =
            lib.genAttrs
              [
                "systemd-journald"
                "systemd-journald@"
                "systemd-journal-remote"
                "systemd-journal-upload"
                "systemd-oomd"
                "systemd-userdbd"
                "systemd-udevd"
                "systemd-timesyncd"
                "systemd-timedated"
                "systemd-portabled"
                "systemd-nspawn@"
                "systemd-machined"
                "systemd-localed"
                "systemd-logind"
                "systemd-importd"
                "systemd-hostnamed"
                "systemd-homed"
                "systemd-networkd"
              ]
              (_: {
                serviceConfig.WatchdogSec = 0;
              });
        }
      )
    ];
  };

  flake.nixosConfigurations = generated.nixosConfigurations;
  flake.darwinConfigurations = generated.darwinConfigurations;
  flake.packages.aarch64-darwin = generated.darwinPackages;
}
