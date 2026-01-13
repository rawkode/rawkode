{
  flake.nixosModules.hardware-intel =
    # Intel hardware configuration
    {
      config,
      lib,
      pkgs,
      ...
    }:
    {
      # Intel CPU
      hardware.cpu.intel.updateMicrocode = lib.mkDefault config.hardware.enableRedistributableFirmware;

      boot = {
        kernelModules = [
          "kvm-intel"
          "coretemp"
          "msr"
        ];
        kernelParams = [ "intel_pstate=active" ];
      };

      # Intel GPU support
      services.xserver.videoDrivers = lib.mkDefault [ "modesetting" ];
      hardware.graphics = {
        enable = true;
        enable32Bit = true;
        extraPackages = with pkgs; [
          intel-media-driver
          vaapiIntel
          vaapiVdpau
          libvdpau-va-gl
        ];
      };

      # Intel-specific packages
      environment.systemPackages = with pkgs; [
        intel-gpu-tools
      ];

      # Thermal management for Intel
      services.thermald.enable = true;
    };
}
