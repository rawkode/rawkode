{
  flake.nixosModules.desktop-common =
    { pkgs, ... }:
    {
      # Valent speaks the KDE Connect protocol; this module installs it and
      # opens the KDE Connect firewall ports. It replaces kdeconnectd, which
      # binds the same ports.
      programs.kdeconnect = {
        enable = true;
        package = pkgs.valent;
      };
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
