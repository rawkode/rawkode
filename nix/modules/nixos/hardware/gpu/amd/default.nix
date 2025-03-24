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
    boot = {
      initrd.kernelModules = [ "amdgpu" ];
      kernelModules = [ "amdgpu" ];
    };
    services.xserver.videoDrivers = [ "amdgpu" ];

    hardware.graphics = {
      enable = true;
      enable32Bit = true;
    };

    # hardware.amdgpu.amdvlk.enable = true;
    # hardware.amdgpu.opencl.enable = true;

    # hardware.graphics = {
    #   extraPackages = with pkgs; [
    #     amdvlk
    #     mesa.opencl
    #     rocmPackages.clr
    #     rocmPackages.clr.icd
    #   ];
    #   extraPackages32 = with pkgs; [
    #     driversi686Linux.amdvlk
    #   ];
    # };

    # systemd.tmpfiles.rules = [
    #   "L+    /opt/rocm/hip   -    -    -     -    ${pkgs.rocmPackages.clr}"
    # ];

    environment.systemPackages = with pkgs; [ lact ];
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
