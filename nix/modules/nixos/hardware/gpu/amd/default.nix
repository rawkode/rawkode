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
    services.xserver.videoDrivers = [ "amdgpu" ];

    boot = {
      kernelModules = [ "amdgpu" ];
      initrd.kernelModules = [ "amdgpu" ];
    };

    # enables AMDVLK & OpenCL support
    hardware.graphics.extraPackages = with pkgs; [
      rocmPackages.clr
      rocmPackages.clr.icd
    ];
  };
}
