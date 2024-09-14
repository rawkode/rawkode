{ lib, pkgs, ... }:
{
  imports = [ ./hardware.nix ];

  rawkOS = {
    desktop = {
      gnome = {
        enable = true;
        paperwm = false;
      };
      wayland.force = true;
    };
    secureboot.enable = true;
    # displayLink.enable = true;
  };

  systemd.services.NetworkManager-wait-online.enable = lib.mkForce false;
  systemd.services.systemd-networkd-wait-online.enable = lib.mkForce false;

  hardware.enableRedistributableFirmware = true;
  hardware.cpu.amd.updateMicrocode = true;

  services.xserver.enable = true;
  boot.initrd.kernelModules = lib.mkBefore [ "amdgpu" ];
  boot.initrd.availableKernelModules = [ "amdgpu" ];
  boot.kernelModules = [ "amdgpu" ];
  services.xserver.videoDrivers = [ "modesetting" ];
  environment.sessionVariables.AMD_VULKAN_ICD = "RADV";
  services.xserver.deviceSection = ''
    Option "VariableRefresh" "true"
  '';
  powerManagement.cpuFreqGovernor = "performance";

  environment.variables.VK_ICD_FILENAMES = "/run/opengl-driver/share/vulkan/icd.d/radeon_icd.x86_64.json";

  hardware.keyboard.qmk.enable = true;
  hardware.opengl.enable = true;

  systemd.services.lactd = {
    description = "AMDGPU Control Daemon";
    enable = true;
    serviceConfig = {
      ExecStart = "${pkgs.lact}/bin/lact daemon";
    };
    wantedBy = [ "multi-user.target" ];
  };

  systemd.tmpfiles.rules = [ "L+	   /opt/amdgpu	   -    -    -     -    ${pkgs.libdrm}" ];

  environment.systemPackages = with pkgs; [
    clinfo
    libva-utils
    vdpauinfo
    vulkan-tools
    lact
    virtualgl

    rocmPackages.rocminfo
    rocmPackages.rocm-smi
  ];

  system.stateVersion = "24.05";
}
