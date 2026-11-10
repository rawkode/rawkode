{
  flake.nixosModules.desktop-common = _: {
    # Installs KDE Connect and opens its firewall ports. The shells' phone
    # widgets drive it through `kdeconnect-cli` and the org.kde.kdeconnect
    # D-Bus API, which D-Bus-activates kdeconnectd on first use.
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
