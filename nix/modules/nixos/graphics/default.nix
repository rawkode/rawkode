{ pkgs, ... }:
{
  hardware.opengl = {
    enable = true;

    extraPackages = with pkgs; [
      libva
      libvdpau-va-gl
      vaapiVdpau
    ];
  };

  services.xserver.videoDrivers = [
    "modesetting"
  ];

}
