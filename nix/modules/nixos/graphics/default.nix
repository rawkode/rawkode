{ pkgs, ... }:
{
  hardware.opengl = {
    enable = true;

    extraPackages = with pkgs; [
      displaylink
      libva
      libvdpau-va-gl
      vaapiVdpau
    ];
  };

  services.xserver.videoDrivers = [
    "displaylink"
    "modesetting"
  ];

}
