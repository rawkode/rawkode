{ config, lib, pkgs, ... }:

let
  cfg = config.services.customFprintd;
in
{
  options.services.customFprintd = {
    enable = lib.mkEnableOption "fingerprint authentication with fprintd";
  };

  config = lib.mkIf cfg.enable {
    # Enable fprintd service
    services.fprintd = {
      enable = true;
      tod = {
        enable = true;
        driver = pkgs.libfprint-2-tod1-goodix;
      };
    };

    # Configure PAM for fingerprint authentication
    security.pam.services = {
      # Enable fingerprint auth for sudo
      sudo.text = lib.mkDefault ''
        #%PAM-1.0
        auth      sufficient      pam_fprintd.so
        auth      include         system-auth
        account   include         system-auth
        session   include         system-auth
      '';

      # Enable for login
      login.fprintAuth = true;
      
      # Enable for GDM
      gdm.fprintAuth = true;
      gdm-password.fprintAuth = true;
      
      # Enable for other desktop managers
      sddm.fprintAuth = true;
      lightdm.fprintAuth = true;
      
      # Enable for polkit
      polkit-1.fprintAuth = true;
      
      # Enable for swaylock
      swaylock.fprintAuth = true;
    };

    # Add current user to the input group for fingerprint reader access
    users.users.${config.users.defaultUser or "rawkode"}.extraGroups = [ "input" ];

    # udev rules for fingerprint reader permissions
    services.udev.extraRules = ''
      # Fingerprint readers
      SUBSYSTEM=="usb", ATTRS{idVendor}=="27c6", ATTRS{idProduct}=="639c", MODE="0666", GROUP="input"
      SUBSYSTEM=="usb", ATTRS{idVendor}=="27c6", ATTRS{idProduct}=="6594", MODE="0666", GROUP="input"
      SUBSYSTEM=="usb", ATTRS{idVendor}=="27c6", ATTRS{idProduct}=="609c", MODE="0666", GROUP="input"
    '';
  };
}