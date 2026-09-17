{
  flake.nixosModules.desktop-common = {
    programs.kdeconnect.enable = true;
    services.libinput = {
      enable = true;
      touchpad = {
        naturalScrolling = true;
        scrollMethod = "twofinger";
        tapping = true;
        clickMethod = "clickfinger";
        disableWhileTyping = true;
      };
      mouse = {
        naturalScrolling = true;
        scrollMethod = "twofinger";
        tapping = true;
        clickMethod = "clickfinger";
        disableWhileTyping = true;
      };
    };
    services.xserver.xkb.layout = "us";

    xdg = {
      portal = {
        enable = true;
        xdgOpenUsePortal = true;
      };
    };
  };
}
