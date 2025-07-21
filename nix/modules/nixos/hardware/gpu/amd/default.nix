{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib.modules) mkIf;
  cfg = config.rawkOS.hardware;
in
{
  config = mkIf (cfg.gpu == "amd") {
    boot.initrd.kernelModules = [ "amdgpu" ];

    services.xserver.videoDrivers = lib.mkDefault [
      "modesetting"
      "amdgpu"
    ];

    hardware = {
      amdgpu = {
        amdvlk = {
          # Prefer mesa
          enable = false;
          support32Bit = {
            enable = true;
          };
          supportExperimental.enable = true;
        };
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

    systemd.tmpfiles.rules = [
      "L+    /opt/rocm/hip   -    -    -     -    ${pkgs.rocmPackages.clr}"
    ];

    environment = {
      systemPackages = with pkgs; [ lact ];
      variables = {
        # VAAPI and VDPAU config for accelerated video.
        # See https://wiki.archlinux.org/index.php/Hardware_video_acceleration
        "VDPAU_DRIVER" = "radeonsi";
        "LIBVA_DRIVER_NAME" = "radeonsi";
      };
    };

    systemd.packages = with pkgs; [ lact ];
    systemd.services.lactd.wantedBy = [ "multi-user.target" ];

    # https://bugzilla.redhat.com/show_bug.cgi?id=2274331
    services.udev.extraRules = ''
            KERNEL=="card0", SUBSYSTEM=="drm", DRIVERS=="amdgpu", ATTR{device/power_dpm_force_performance_level}="high"
            KERNEL=="card1", SUBSYSTEM=="drm", DRIVERS=="amdgpu", ATTR{device/power_dpm_force_performance_level}="high"
      			KERNEL=="card2", SUBSYSTEM=="drm", DRIVERS=="amdgpu", ATTR{device/power_dpm_force_performance_level}="high"
    '';
  };
}
