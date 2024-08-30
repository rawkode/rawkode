{ pkgs, ... }:
{
  imports = [ ./hardware.nix ];

  rawkOS = {
    desktop = {
      gnome = {
        enable = false;
        paperwm = false;
      };
      plasma.enable = true;
      wayland.force = true;
    };
    secureboot.enable = true;
    # displayLink.enable = true;
  };

  hardware.opengl = {
    enable = true;
    extraPackages = with pkgs; [
      rocmPackages.clr.icd
      rocmPackages.clr
    ];
  };

  systemd.tmpfiles.rules = [ "L+    /opt/rocm/hip   -    -    -     -    ${pkgs.rocmPackages.clr}" ];

  system.stateVersion = "24.05";
}
