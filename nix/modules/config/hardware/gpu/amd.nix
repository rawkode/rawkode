_: {
  flake.nixosModules.hardware-gpu-amd =
    {
      pkgs,
      ...
    }:
    {
      environment.systemPackages = with pkgs; [
        vulkan-tools
      ];

      hardware = {
        amdgpu = {
          initrd.enable = true;
          opencl.enable = true;
          # Enable GPU overclocking. The overdrive ppfeaturemask also disables
          # GFXOFF and stutter mode, so keep it off integrated/laptop GPUs.
          overdrive.enable = true;
        };

        graphics = {
          enable = true;
          extraPackages = with pkgs; [
            vulkan-validation-layers
            vulkan-extension-layer
          ];
        };
      };

      systemd.tmpfiles.rules = [
        "L+    /opt/rocm/hip   -    -    -     -    ${pkgs.rocmPackages.clr}"
      ];

      environment.variables = {
        # VAAPI and VDPAU config for accelerated video.
        # See https://wiki.archlinux.org/index.php/Hardware_video_acceleration
        VDPAU_DRIVER = "radeonsi";
        LIBVA_DRIVER_NAME = "radeonsi";
      };
    };
}
