{ ... }:
{
  services = {
    displayManager.cosmic-greeter.enable = false;
    desktopManager.cosmic.enable = true;

    xserver.xkb.layout = "us";
    xserver = {
      enable = true;
      desktopManager.gnome.enable = true;
      displayManager.gdm.enable = true;
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
