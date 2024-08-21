{
  imports = [ ./hyprland.nix ];

  services = {
    xserver.xkb.layout = "us";
    xserver = {
      enable = true;
      displayManager.gdm.enable = true;
      displayManager.gdm.wayland = true;
    };
  };
}
