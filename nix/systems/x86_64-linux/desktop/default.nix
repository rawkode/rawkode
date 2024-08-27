{ ... }:
{
  imports = [ ./hardware.nix ];

  rawkOS = {
    desktop = {
      gnome = {
        enable = true;
        paperwm = false;
      };
      wayland.force = true;
    };
    secureboot.enable = true;
  };

  system.stateVersion = "24.05";
}
