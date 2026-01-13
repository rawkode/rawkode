{
  flake.nixosModules.kernel =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    {
      boot = {
        consoleLogLevel = 0;

        kernelPackages = pkgs.linuxKernel.packages.linux_zen;
        # CachyOS-inspired kernel parameters for better desktop responsiveness and gaming
        kernelParams = [
          "nowatchdog"
          "preempt=full"
          "threadirqs"
          "tsc=reliable"
          "clocksource=tsc"
          "preempt=voluntary"
          "futex.futex2_interface=1" # Better Wine/Proton compatibility
          "NVreg_UsePageAttributeTable=1" # Improved GPU memory management
          "io_uring.sqpoll=2" # Modern I/O scheduler polling
          "transparent_hugepage=madvise" # Better memory management
          "elevator=bfq" # Better I/O scheduling for gaming
        ];
        kernelModules = [ "v4l2loopback" ];

        initrd = {
          systemd.enable = true;
          supportedFilesystems = [ "btrfs" ];
          availableKernelModules = [
            "nvme"
            "xhci_pci"
            "thunderbolt"
            "usb_storage"
            "sd_mod"
            "mt7921e" # WiFi support for Framework
          ];
        };

        bootspec = {
          enable = true;
          enableValidation = true;
        };

        loader = {
          efi.canTouchEfiVariables = true;
          systemd-boot.configurationLimit = 10;
          systemd-boot.consoleMode = "max";
          systemd-boot.enable = true;
          systemd-boot.memtest86.enable = true;
          timeout = 10;
        };

        extraModulePackages = with config.boot.kernelPackages; [ v4l2loopback ];

        plymouth.enable = true;
        tmp.cleanOnBoot = true;
      };

      networking.useNetworkd = true;
      systemd.services.systemd-networkd-wait-online.enable = lib.mkForce false;

      nix.channel.enable = false;

      console.useXkbConfig = true;
    };
}
