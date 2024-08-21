{ pkgs, ... }:
{
  hardware.graphics = {
    enable = true;

    extraPackages = with pkgs; [
      # stable.displaylink
      libva
      libvdpau-va-gl
      vaapiVdpau
    ];
  };

  services.xserver.videoDrivers = [
    "modesetting"
    # "displaylink"
  ];

}
