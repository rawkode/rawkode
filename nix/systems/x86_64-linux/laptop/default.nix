{ ... }:
{
  imports = [ ./hardware.nix ];

  rawkOS = {
    desktop = {
      gnome.enable = true;
      wayland.force = true;
    };
    secureboot.enable = true;
  };

  programs.dconf.enable = true;
  dconf = {
    enable = true;
    profiles.gdm.databases = [
      { settings."org/gnome/login-screen".enable-fingerprint-authentication = true; }
    ];
  };

  # Powersaving Settings
  services.thermald.enable = true;

  system.stateVersion = "24.11";
}
