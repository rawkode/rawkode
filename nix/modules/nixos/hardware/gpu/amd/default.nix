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
    hardware.graphics = {
      enable = true;
      enable32Bit = true;
    };
    hardware.amdgpu.opencl.enable = true;
    hardware.graphics.extraPackages = with pkgs; [
      mesa.opencl
      rocmPackages.clr
      rocmPackages.clr.icd
    ];

    hardware.opengl = {
      extraPackages = with pkgs; [
        amdvlk
      ];
      extraPackages32 = with pkgs; [
        driversi686Linux.amdvlk
      ];
    };

    systemd.tmpfiles.rules = [
      "L+    /opt/rocm/hip   -    -    -     -    ${pkgs.rocmPackages.clr}"
    ];

    boot = {
      initrd.kernelModules = [ "amdgpu" ];
      kernelModules = [ "amdgpu" ];
    };

    environment.systemPackages = with pkgs; [ lact ];
    systemd.packages = with pkgs; [ lact ];
    systemd.services.lactd.wantedBy = [ "multi-user.target" ];

    services.xserver.videoDrivers = [ "amdgpu" ];

    # https://bugzilla.redhat.com/show_bug.cgi?id=2274331
    services.udev.extraRules = ''
      KERNEL=="card0", SUBSYSTEM=="drm", DRIVERS=="amdgpu", ATTR{device/power_dpm_force_performance_level}="high"
      KERNEL=="card1", SUBSYSTEM=="drm", DRIVERS=="amdgpu", ATTR{device/power_dpm_force_performance_level}="high"
    '';
  };
}
