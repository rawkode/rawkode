# Framework laptop system configuration (p4x-laptop) - Dendritic pattern
{ inputs, ... }:
{
  flake.nixosConfigurations.p4x-laptop-nixos = inputs.nixpkgs.lib.nixosSystem {
    system = "x86_64-linux";
    modules = [
      # Hardware modules
      inputs.nixos-hardware.nixosModules.framework-13-7040-amd

      # Import profiles (includes disko, lanzaboote, flatpaks via profiles-base)
      inputs.self.nixosModules.profiles-desktop
      inputs.self.nixosModules.disko-btrfs-encrypted
      inputs.self.nixosModules.lanzaboote

      # User configuration
      inputs.self.nixosModules.users-rawkode

      # Machine-specific configuration
      (
        { pkgs, ... }:
        {
          # System identity
          networking.hostName = "p4x-laptop-nixos";

          # Disko device override (uses shared configuration from disko-btrfs-encrypted module)
          rawkOS.disko.device = "/dev/nvme0n1";

          # Laptop-specific features
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
              settings.Login = {
                HandleLidSwitch = "suspend-then-hibernate";
                HandleLidSwitchExternalPower = "lock";
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

          # Hardware configuration
          hardware.enableRedistributableFirmware = true;
          hardware.cpu.amd.updateMicrocode = true;
          hardware.keyboard.qmk.enable = true;
          hardware.graphics.enable = true;

          # Swap
          swapDevices = [
            {
              device = "/var/lib/swapfile";
              size = 48 * 1024;
            }
          ];

        }
      )
    ];
    specialArgs = {
      inherit inputs;
    };
  };
}
