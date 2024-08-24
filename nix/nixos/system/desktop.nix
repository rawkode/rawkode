{ ... }:
{
  services = {
    displayManager.cosmic-greeter.enable = true;
    desktopManager.cosmic.enable = true;

    xserver.xkb.layout = "us";
    xserver = {
      enable = true;
      displayManager.gdm.enable = false;
      displayManager.gdm.wayland = true;
    };
  };

  xdg = {
    portal = {
      enable = true;
      xdgOpenUsePortal = true;
    };
  };
}
