{ pkgs, ... }:
{
  hardware.graphics = {
    enable = true;

    extraPackages = with pkgs; [
      displaylink
      libva
      libvdpau-va-gl
      vaapiVdpau
    ];
    extraPackages32 = with pkgs.pkgsi686Linux; [
      vaapiVdpau
      libvdpau-va-gl
    ];
  };

  services.xserver.videoDrivers = [
    "modesetting"
    "displaylink"
  ];

}
