{
  flake.nixosModules.kernel =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      useZenKernel = !pkgs.stdenv.hostPlatform.isAarch64;
    in
    {
      options.rawkOS.kernel.lowLatency = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Use latency-oriented kernel parameters (full preemption, threaded IRQs). Costs power; disable on battery-powered machines.";
      };

      config.boot = {
        consoleLogLevel = 0;

        kernelPackages =
          (if useZenKernel then pkgs.linuxKernel.packages.linux_zen else pkgs.linuxPackages).extend
            (
              _: prev: {
                # The module aggregator expects a kmodigest `.ko.cer` per external
                # module, which only `modules_install` produces; upstream copies the
                # bare `.ko`.
                framework-laptop-kmod = prev.framework-laptop-kmod.overrideAttrs {
                  installPhase = ''
                    runHook preInstall
                    make $makeFlags INSTALL_MOD_PATH=$out INSTALL_MOD_DIR=extra modules_install
                    find $out/lib/modules -maxdepth 2 -type f -name 'modules.*' -delete
                    runHook postInstall
                  '';
                };
              }
            );
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

        plymouth.enable = true;
        tmp.cleanOnBoot = true;
      };

      config.networking.useNetworkd = true;
      config.systemd.services.systemd-networkd-wait-online.enable = lib.mkForce false;

      config.nix.channel.enable = false;

      config.console.useXkbConfig = true;
    };
}
