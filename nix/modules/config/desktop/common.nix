{
  flake.nixosModules.common = {
    services.xserver.xkb.layout = "us";

    xdg = {
      portal = {
        enable = true;
        xdgOpenUsePortal = true;
      };
    };
  };
}
