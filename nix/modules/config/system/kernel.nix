{
  flake.nixosModules.kernel =
    {
      config,
      lib,
      ...
    }:
    {
      options.rawkOS.kernel.lowLatency = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Use latency-oriented kernel parameters (full preemption, threaded IRQs). Costs power; disable on battery-powered machines.";
      };

      config.boot = {
        # CachyOS-inspired kernel parameters for better desktop responsiveness and gaming
        kernelParams = [
          "nowatchdog"
          "tsc=reliable"
          "clocksource=tsc"
          "transparent_hugepage=madvise" # Better memory management
        ]
        ++ lib.optionals config.rawkOS.kernel.lowLatency [
          "preempt=full"
          "threadirqs"
        ];
        kernelModules = [ "v4l2loopback" ];

        initrd = {
          supportedFilesystems = [ "btrfs" ];
          availableKernelModules = [
            "nvme"
            "xhci_pci"
            "thunderbolt"
            "usb_storage"
            "sd_mod"
          ];
        };

        # Bootspec is now always generated; only validation remains configurable.
        bootspec.enableValidation = true;

        loader = {
          efi.canTouchEfiVariables = true;
          systemd-boot.configurationLimit = 10;
          systemd-boot.consoleMode = "max";
          systemd-boot.enable = true;
          systemd-boot.memtest86.enable = true;
          timeout = 10;
        };

        # Kernel 7.2's modules_install runs depmod into $out; drop the generated
        # index files so they don't collide with the kernel's own in buildEnv.
        extraModulePackages = [
          (config.boot.kernelPackages.v4l2loopback.overrideAttrs (old: {
            postInstall = (old.postInstall or "") + ''
              find $out/lib/modules -maxdepth 2 -type f -name 'modules.*' -delete
            '';
          }))
        ];
      };
    };
}
