# Framework laptop system configuration - Dendritic pattern
{ inputs, ... }:
{
  flake.nixosConfigurations.p4x-framework-nixos = inputs.nixpkgs.lib.nixosSystem {
    system = "x86_64-linux";
    modules = [
      # Hardware modules
      inputs.nixos-hardware.nixosModules.framework-13-7040-amd

      # Flake inputs
      inputs.disko.nixosModules.disko
      inputs.lanzaboote.nixosModules.lanzaboote
      inputs.flatpaks.nixosModules.nix-flatpak

      # Import profiles
      inputs.self.nixosModules.profiles-desktop
      inputs.self.nixosModules.profiles-development
      inputs.self.nixosModules.hardware-amd
      inputs.self.nixosModules.kernel
      inputs.self.nixosModules.disko-btrfs-encrypted
      inputs.self.nixosModules.lanzaboote

      # Machine-specific configuration
      (
        {
          lib,
          pkgs,
          ...
        }:
        {
          # System identity
          networking.hostName = "p4x-framework-nixos";

          # Disko device override (uses shared configuration from disko-btrfs-encrypted module)
          rawkOS.disko.device = "/dev/nvme0n1";

          # Laptop-specific features (Framework is a laptop)
          services = {
            thermald.enable = true;
            upower = {
              enable = true;
              percentageLow = 15;
              percentageCritical = 7;
              percentageAction = 5;
              criticalPowerAction = "Hibernate";
            };
            logind = {
              lidSwitch = "suspend-then-hibernate";
              lidSwitchExternalPower = "lock";
              settings.Login = {
                HandlePowerKey = "suspend-then-hibernate";
                HibernateDelaySec = 3600;
              };
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

          # Network configuration is handled by networking module

          # Framework-specific hardware configuration
          services.fprintd.enable = true;
          boot.kernelParams = [ "amdgpu.sg_display=0" ];
          boot.kernelModules = [
            "cros_ec"
            "cros_ec_lpcs"
            "mt7921e"
          ];
          environment.variables = {
            QT_AUTO_SCREEN_SCALE_FACTOR = "1";
          };

          # Hardware configuration
          hardware.enableRedistributableFirmware = true;
          hardware.cpu.amd.updateMicrocode = true;
          hardware.keyboard.qmk.enable = true;
          hardware.graphics.enable = true;

          # Lanzaboote replaces systemd-boot when secure boot is enabled
          # boot.loader.systemd-boot.enable is handled by lanzaboote

          # Swap
          swapDevices = [
            {
              device = "/var/lib/swapfile";
              size = 96 * 1024;
            }
          ];

          # Framework-specific overrides
          # Re-enable power-profiles-daemon (removed auto-cpufreq)
          services.power-profiles-daemon.enable = lib.mkDefault true;

          # Nix settings
          nix.settings = {
            substituters = [
              "https://niri.cachix.org"
              "https://wezterm.cachix.org"
            ];
            trusted-public-keys = [
              "niri.cachix.org-1:Wv0OmO7PsuocRKzfDoJ3mulSl7Z6oezYhGhR+3W2964="
              "wezterm.cachix.org-1:kAbhjYUC9qvblTE+s7S+kl5XM1zVa4skO+E/1IDWdH0="
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
