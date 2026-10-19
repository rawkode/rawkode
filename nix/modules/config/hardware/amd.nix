# AMD hardware configuration - Dendritic pattern flake-parts module
{
  flake.nixosModules.hardware-amd =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    {
      # AMD CPU
      hardware.cpu.amd.updateMicrocode = lib.mkDefault config.hardware.enableRedistributableFirmware;

      boot = {
        kernelModules = [
          "kvm-amd"
          "amd-pstate"
          "zenpower"
          "msr"
        ];
        kernelParams = [ "amd_pstate=active" ];
      };

      # AMD GPU support
      services.xserver.videoDrivers = lib.mkDefault [ "amdgpu" ];
      hardware.graphics = {
        enable = true;
        enable32Bit = true;
      };

      # AMD-specific packages
      environment.systemPackages = with pkgs; [
        amdctl
        radeontop
        ryzenadj
        zenmonitor
      ];
    };
}
