{ pkgs, ... }:
{
  hardware.graphics = {
    enable = true;

    extraPackages = with pkgs; [
      stable.displaylink
      stable.libva
      stable.libvdpau-va-gl
      stable.vaapiVdpau
    ];
  };

  services.xserver.videoDrivers = [
    "modesetting"
    # "displaylink"
  ];

}
