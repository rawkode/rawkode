_: {
  flake.nixosModules.hardware-gpu-amd =
    {
      pkgs,
      ...
    }:
    {
      boot.initrd.kernelModules = [ "amdgpu" ];

      hardware = {
        amdgpu = {
          initrd.enable = true;
          opencl.enable = true;
        };

        graphics = {
          enable = true;
          extraPackages = with pkgs; [
            mesa
            vulkan-tools
            vulkan-loader
            vulkan-validation-layers
            vulkan-extension-layer
          ];
        };
      };

      # Enable corectrl for GPU control
      programs.corectrl = {
        enable = true;
      };

      # Enable GPU overclocking. The overdrive ppfeaturemask also disables
      # GFXOFF and stutter mode, so keep it off integrated/laptop GPUs.
      hardware.amdgpu.overdrive.enable = true;

      systemd.tmpfiles.rules = [
        "L+    /opt/rocm/hip   -    -    -     -    ${pkgs.rocmPackages.clr}"
      ];

      environment = {
        variables = {
          # VAAPI and VDPAU config for accelerated video.
          # See https://wiki.archlinux.org/index.php/Hardware_video_acceleration
          "VDPAU_DRIVER" = "radeonsi";
          "LIBVA_DRIVER_NAME" = "radeonsi";
        };
      };

      # https://bugzilla.redhat.com/show_bug.cgi?id=2274331
      services.udev.extraRules = ''
              KERNEL=="card0", SUBSYSTEM=="drm", DRIVERS=="amdgpu", ATTR{device/power_dpm_force_performance_level}="high"
              KERNEL=="card1", SUBSYSTEM=="drm", DRIVERS=="amdgpu", ATTR{device/power_dpm_force_performance_level}="high"
        			KERNEL=="card2", SUBSYSTEM=="drm", DRIVERS=="amdgpu", ATTR{device/power_dpm_force_performance_level}="high"
      '';
    };
}
