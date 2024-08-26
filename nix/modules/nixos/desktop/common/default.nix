{
  services.xserver.enable = true;
  services.xserver.xkb.layout = "us";

  xdg = {
    portal = {
      enable = true;
      xdgOpenUsePortal = true;
    };
  };
}
